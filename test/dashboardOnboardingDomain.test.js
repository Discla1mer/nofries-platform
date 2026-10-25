'use strict';

// Synthetic pure-domain contract tests. These fixtures are not production policy
// or evidence of identity verification, admission, persistence or deployment.
const assert = require('node:assert/strict');
const domain = require('../api/shared/appLifecycle/dashboardOnboardingDomain');
const { createTenantAggregate, resolveOrganisation, transitionTenant, transitionOrganisation } = require('../api/shared/appLifecycle/tenantDomain');
const { createMembershipState, applyMembershipCommand, normaliseMembershipState,
    resolveActiveMembership } = require('../api/shared/appLifecycle/membershipDomain');
const { normaliseEntitlementState, resolveEntitlements } = require('../api/shared/appLifecycle/entitlementDomain');
const { normaliseAdvisorAssignment } = require('../api/shared/appLifecycle/portalPermissions');

const uuid = n => `30000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const SCOPE = Object.freeze({ tenantId: 'synthetic-runtime-tenant', organisationId: 'synthetic-runtime-org' });
const INITIATOR = `${uuid(1)}:${uuid(2)}`;
const CUSTOMER = `${uuid(3)}:${uuid(4)}`;
const OTHER = `${uuid(3)}:${uuid(5)}`;
const START = '2026-09-07T00:00:00.000Z';
const CREATED = '2026-09-07T01:00:00.000Z';
const VERIFIED = '2026-09-07T02:00:00.000Z';
const APPROVED = '2026-09-07T03:00:00.000Z';
const ACCEPTED = '2026-09-07T04:00:00.000Z';
const APPROVAL_END = '2026-09-07T05:00:00.000Z';
const CASE_END = '2026-09-07T06:00:00.000Z';
const LATER = '2026-09-08T00:00:00.000Z';
const END = '2027-09-07T00:00:00.000Z';
const clone = value => JSON.parse(JSON.stringify(value));

function identity(overrides = {}) {
    return { policyId: 'synthetic-customer-policy', policyRevision: 2,
        issuer: 'https://identity.example.test/synthetic/v2.0',
        identityTenantId: uuid(3), oid: uuid(4), audience: 'synthetic-dashboard-client', ...overrides };
}
function aggregate() {
    return createTenantAggregate({ schemaVersion: 1,
        tenant: { schemaVersion: 1, tenantId: SCOPE.tenantId,
            displayName: 'Synthetic runtime tenant', recordStatus: 'active', revision: 0 },
        organisations: [{ schemaVersion: 1, ...SCOPE, displayName: 'Synthetic runtime organisation',
            domains: [], recordStatus: 'active', revision: 0 }] });
}
function entitlement() {
    return { schemaVersion: 1, ...SCOPE, revision: 0,
        grants: [{ ...SCOPE, grantId: 'synthetic-base-product', code: 'dashboard_score',
            status: 'active', validFrom: START, validUntil: END,
            agreementRef: 'synthetic-approved-agreement', modules: ['overview'], frameworks: [],
            limits: { memberships: 8 }, coverage: [], actions: [] }] };
}
function flags() {
    return { ...SCOPE, revision: 0, enabled: { dashboard: true, overview: true }, frameworks: [] };
}
function template(kind = 'bootstrap', overrides = {}) {
    const value = { schemaVersion: 1, kind, scope: { ...SCOPE },
        membership: { invitationId: 'synthetic-customer-invitation', membershipId: 'synthetic-customer-member',
            roles: ['admin'], validFrom: START, validUntil: END,
            grantEvidenceId: 'synthetic-approved-role-evidence' }, bindingId: uuid(20) };
    if (kind === 'bootstrap') value.bootstrap = { tenantAggregate: aggregate(),
        entitlementState: entitlement(), flags: flags(), advisorGrants: [] };
    return { ...value, ...overrides };
}
function advisorGrant(overrides = {}) {
    return { assignmentId: 'synthetic-advisor-assignment', status: 'active', validFrom: START,
        validUntil: END, modules: ['cyber_security'], permissions: ['assessment.read'],
        grantEvidenceId: 'synthetic-explicit-advisor-evidence', ...overrides };
}
function addMembership(state, owner, subjectKey, invitationId, membershipId, now) {
    const invite = applyMembershipCommand(state, owner, { ...SCOPE,
        expectedRevision: state.revision, actorSubjectKey: INITIATOR, now, action: 'invite',
        payload: { invitationId, subjectKey, roles: ['viewer'], validFrom: START,
            validUntil: END, grantEvidenceId: `synthetic-${membershipId}-evidence`, expiresAt: END } });
    return applyMembershipCommand(invite, owner, { ...SCOPE, expectedRevision: invite.revision,
        actorSubjectKey: subjectKey, now, action: 'accept', payload: { invitationId, membershipId } });
}
function predecessor() {
    const owner = aggregate();
    const membershipState = addMembership(createMembershipState(owner, SCOPE, START), owner,
        OTHER, 'synthetic-unrelated-invitation', 'synthetic-unrelated-member', START);
    return { tenantAggregate: owner, membershipState, entitlementState: entitlement(),
        flags: flags(), advisorAssignments: [] };
}
function expectedMembership(selected, before, at = ACCEPTED, expiry = APPROVAL_END) {
    const owner = before ? before.tenantAggregate : selected.bootstrap.tenantAggregate;
    const initial = before ? before.membershipState : createMembershipState(owner, SCOPE, at);
    const { membershipId, ...grant } = selected.membership;
    const invited = applyMembershipCommand(initial, owner, { ...SCOPE,
        expectedRevision: initial.revision, actorSubjectKey: INITIATOR, now: at, action: 'invite',
        payload: { ...grant, subjectKey: CUSTOMER, expiresAt: expiry } });
    return applyMembershipCommand(invited, owner, { ...SCOPE, expectedRevision: invited.revision,
        actorSubjectKey: CUSTOMER, now: at, action: 'accept',
        payload: { invitationId: selected.membership.invitationId, membershipId: selected.membership.membershipId } });
}
function acceptanceInput(overrides = {}) {
    return { template: template(), identity: identity(), initiatorSubjectKey: INITIATOR,
        caseAcceptBefore: CASE_END, approvalAcceptBefore: APPROVAL_END,
        acceptedAt: ACCEPTED, predecessor: null, ...overrides };
}
function reconstructionFacts(input) {
    const { template: selected, identity: principal, initiatorSubjectKey,
        caseAcceptBefore, approvalAcceptBefore } = input;
    return { template: selected, identity: principal, initiatorSubjectKey,
        caseAcceptBefore, approvalAcceptBefore };
}
function authorityRef(overrides = {}) { return { authorityId: uuid(30), revision: 2, sha256: 'a'.repeat(64), ...overrides }; }
function caseInput(overrides = {}) {
    return { caseId: uuid(31), templateRef: 'synthetic-template-v1', template: template(),
        acceptBefore: CASE_END, initiatorSubjectKey: INITIATOR, authorityRef: authorityRef(),
        operationId: uuid(32), createdAt: CREATED, ...overrides };
}
function proofInput(overrides = {}) {
    return { proofId: uuid(33), caseId: uuid(31), scope: { ...SCOPE }, caseRevision: 0,
        identity: identity(), authenticationSha256: 'b'.repeat(64), verifiedAt: VERIFIED,
        freshUntil: APPROVAL_END, operationId: uuid(34), ...overrides };
}
function caseCommand(state, action, payload, overrides = {}) {
    return { action, operationId: uuid(40), expectedRevision: state.revision,
        actorSubjectKey: INITIATOR, at: APPROVED, payload, ...overrides };
}
function approvedCase(selected = template()) {
    const created = domain.createOnboardingCase(caseInput({ template: selected }));
    const proof = domain.createIdentityProof(proofInput());
    const bindCommand = caseCommand(created, 'bind_identity', { proof },
        { operationId: uuid(35), actorSubjectKey: CUSTOMER, at: VERIFIED });
    const bound = domain.applyOnboardingCommand(created, bindCommand);
    const approveCommand = caseCommand(bound, 'approve', { approvalId: uuid(36), acceptBefore: APPROVAL_END,
        authorityRef: authorityRef() }, { operationId: uuid(37) });
    return { created, proof, bindCommand, bound, approveCommand,
        approved: domain.applyOnboardingCommand(bound, approveCommand) };
}
function acceptedCase(selected = template(), before = null, acceptanceProof = null) {
    const example = approvedCase(selected);
    const receipt = domain.createAcceptanceReceipt({ receiptId: uuid(38), caseState: example.approved,
        proof: acceptanceProof || example.proof, operationId: uuid(39), acceptedAt: ACCEPTED, predecessor: before });
    const acceptCommand = caseCommand(example.approved, 'accept', { receipt },
        { operationId: uuid(39), actorSubjectKey: CUSTOMER, at: ACCEPTED });
    const accepted = domain.applyOnboardingCommand(example.approved, acceptCommand);
    const currentAuthority = receipt.effect.kind === 'bootstrap' ? clone(receipt.effect.initialState)
        : { ...clone(receipt.effect.predecessor), membershipState: clone(receipt.effect.nextMembershipState) };
    return { ...example, receipt, acceptCommand, accepted, currentAuthority };
}
function freshProof(state, overrides = {}) {
    return domain.createIdentityProof(proofInput({ proofId: uuid(50), caseRevision: state.revision,
        operationId: uuid(51), authenticationSha256: 'c'.repeat(64), verifiedAt: LATER,
        freshUntil: '2026-09-08T01:00:00.000Z', ...overrides }));
}
function rehash(record, key) {
    const core = { ...record }; delete core[key];
    record[key] = domain.canonicalDigest(core);
    return record;
}
function publicationInput(overrides = {}) {
    const currentAuthority = predecessor(), member = currentAuthority.membershipState.memberships[0];
    return { receiptId: uuid(101), operationId: uuid(102), scope: { ...SCOPE },
        membershipId: member.membershipId, invitationId: member.invitationId, grantEvidenceId: member.grantEvidenceId,
        identity: identity({ oid: uuid(5) }), bindingId: uuid(103), validFrom: START, validUntil: END,
        authorityRef: authorityRef(), actorSubjectKey: INITIATOR, at: APPROVED, currentAuthority, ...overrides };
}
function terminalPredecessor(kind) {
    const prior = predecessor();
    const act = (action, payload, at) => {
        prior.membershipState = applyMembershipCommand(prior.membershipState, prior.tenantAggregate,
            { ...SCOPE, expectedRevision: prior.membershipState.revision,
                actorSubjectKey: INITIATOR, now: at, action, payload });
    };
    if (kind === 'removed member') act('remove', { membershipId: 'synthetic-unrelated-member' }, CREATED);
    else {
        act('invite', { invitationId: 'synthetic-terminal-invite', subjectKey: `${uuid(3)}:${uuid(120)}`,
            roles: ['viewer'], validFrom: START, validUntil: END, grantEvidenceId: 'synthetic-terminal-evidence',
            expiresAt: kind === 'expired invitation' ? VERIFIED : END }, START);
        if (kind === 'revoked invitation') act('revoke', { invitationId: 'synthetic-terminal-invite' }, APPROVED);
    }
    return prior;
}
function admissionCommand(before = null, operationType = 'publishAdmissionDecision', operationId = uuid(150)) {
    return { schemaVersion: 1, operationType, operationId, actorSubjectKey: INITIATOR, authorityId: uuid(151),
        expectedRevision: before ? before.revision : null, expectedHeadSha256: before ? before.decisionSha256 : null,
        payload: { target: { ...SCOPE }, identityPolicyRef: { policyId: identity().policyId, policyRevision: 2 },
            approvedEffectSha256: domain.canonicalDigest(template()),
            evidenceRefs: [{ kind: 'approval', id: 'synthetic-maintenance-approval', sha256: 'a'.repeat(64) }],
            validFrom: START, validUntil: END } };
}
function admissionReceipt(before = null, operationType = 'publishAdmissionDecision', index = 150, at = CREATED, overrides = {}) {
    return domain.createTransitionReceipt({ receiptId: uuid(index + 1), auditEventId: uuid(index + 2),
        predecessor: before, command: admissionCommand(before, operationType, uuid(index)), facts: { occurredAt: at }, ...overrides });
}
function sessionFixture() {
    const publication = domain.publishExistingMembershipBinding(publicationInput());
    const seed = { identityPayload: identity({ oid: uuid(5) }), instanceId: uuid(200), restoreEpoch: uuid(201),
        issuedAt: CREATED, expiresAt: APPROVAL_END };
    const issuance = { schemaVersion: 1, kind: 'operator_dashboard_issuance', sessionSha256: '4'.repeat(64),
        identitySha256: domain.canonicalDigest(seed.identityPayload), instanceId: seed.instanceId,
        restoreEpoch: seed.restoreEpoch, issuedAt: seed.issuedAt, expiresAt: seed.expiresAt };
    const command = { schemaVersion: 1, operationType: 'initializeOperatorSession', operationId: uuid(202),
        sessionSha256: issuance.sessionSha256, actorSubjectKey: OTHER,
        payload: { seed, operatorIssuanceSha256: domain.canonicalDigest(issuance) } };
    const facts = { occurredAt: CREATED, generationToken: '5'.repeat(64), operatorIssuanceProof: issuance };
    return { seed, issuance, command, facts, binding: publication.binding };
}
function selectionInput(before, binding, token = '6'.repeat(64), operationId = uuid(210), at = APPROVED) {
    return { predecessor: before, command: { schemaVersion: 1, operationType: 'selectBinding', operationId,
        sessionSha256: before.sessionSha256, actorSubjectKey: before.subjectKey,
        payload: { bindingId: binding.bindingId, expectedRevision: before.revision,
            expectedSelectionGeneration: before.selectionGeneration, expectedGeneration: before.generationToken } },
        facts: { occurredAt: at, generationToken: token, binding } };
}
function rejected(run, expectedCode) {
    assert.throws(run, error => error instanceof domain.DashboardOnboardingError &&
        (!expectedCode || error.code === expectedCode) &&
        ['onboarding_input_invalid', 'onboarding_conflict', 'onboarding_access_denied',
            'onboarding_request_too_large', 'onboarding_record_invalid'].includes(error.code));
}

describe('POR010 closed identity and declarative template', () => {
    test('normalizes the full stable tuple without substituting email or canonical owner IDs', () => {
        const input = identity(), normalized = domain.normaliseStableIdentity(input);
        assert.deepEqual(normalized, input);
        deeplyFrozen(normalized);
        input.issuer = 'https://changed.example.test';
        assert.notEqual(normalized.issuer, input.issuer);
        assert.notEqual(domain.canonicalDigest(normalized), domain.canonicalDigest(identity({ policyRevision: 3 })));
        assert.notEqual(domain.canonicalDigest(normalized), domain.canonicalDigest(identity({ audience: 'another-client' })));
    });

    test.each([
        ['extra email', value => { value.email = 'synthetic@example.test'; }],
        ['missing audience', value => { delete value.audience; }],
        ['uppercase subject UUID', value => { value.oid = 'ABCDEFAB-0000-4000-8000-000000000001'; }],
        ['wildcard policy ID', value => { value.policyId = '*'; }],
        ['unsafe revision', value => { value.policyRevision = Number.MAX_SAFE_INTEGER + 1; }],
        ['negative zero revision', value => { value.policyRevision = -0; }],
        ['NUL issuer', value => { value.issuer += '\u0000'; }],
        ['lone high surrogate', value => { value.audience += '\ud800'; }],
        ['lone low surrogate', value => { value.audience += '\udc00'; }],
        ['issuer UTF8 overflow', value => { value.issuer = '界'.repeat(342); }]
    ])('rejects %s in the identity tuple', (_, change) => {
        const value = identity(); change(value);
        rejected(() => domain.normaliseStableIdentity(value), 'onboarding_input_invalid');
    });

    test('preserves valid Unicode pairs and supports the complete allowed identity string byte bound', () => {
        const value = identity({ issuer: '界'.repeat(341) + 'x', audience: 'Synthetic 😀 identity' });
        assert.deepEqual(domain.normaliseStableIdentity(value), value);
    });

    test('template is detached and frozen; neither variant creates a membership or usage snapshot', () => {
        for (const kind of ['bootstrap', 'existing_organisation']) {
            const input = template(kind), before = clone(input), value = domain.normaliseTemplate(input);
            assert.deepEqual(value, before);
            deeplyFrozen(value);
            input.membership.roles.push('viewer');
            assert.deepEqual(value.membership.roles, ['admin']);
            for (const key of ['subjectKey', 'membershipState', 'usage', 'acceptedAt']) assert.equal(Object.hasOwn(value, key), false);
        }
    });

    test.each([
        ['unknown subject', value => { value.subjectKey = CUSTOMER; }],
        ['ready-made state', value => { value.membershipState = predecessor().membershipState; }],
        ['caller usage', value => { value.usage = []; }],
        ['generated timestamp', value => { value.membership.createdAt = ACCEPTED; }],
        ['missing flags', value => { delete value.bootstrap.flags; }],
        ['missing entitlements', value => { delete value.bootstrap.entitlementState; }],
        ['missing advisor array', value => { delete value.bootstrap.advisorGrants; }],
        ['missing canonical tenant revision', value => { delete value.bootstrap.tenantAggregate.tenant.revision; }],
        ['missing organisation status', value => { delete value.bootstrap.tenantAggregate.organisations[0].recordStatus; }],
        ['nonzero initial tenant revision', value => { value.bootstrap.tenantAggregate.tenant.revision = 1; }],
        ['nonzero initial organisation revision', value => { value.bootstrap.tenantAggregate.organisations[0].revision = 1; }],
        ['missing explicit first admin', value => { value.membership.roles = ['editor']; }],
        ['second bootstrap organisation', value => { value.bootstrap.tenantAggregate.organisations.push({ ...value.bootstrap.tenantAggregate.organisations[0], organisationId: 'second-org' }); }],
        ['foreign bootstrap org', value => { value.bootstrap.tenantAggregate.organisations[0].organisationId = 'foreign-org'; }],
        ['foreign entitlement scope', value => { value.bootstrap.entitlementState.tenantId = 'foreign-tenant'; }],
        ['foreign flags', value => { value.bootstrap.flags.organisationId = 'foreign-org'; }],
        ['wildcard membership ID', value => { value.membership.membershipId = '*'; }],
        ['year zero', value => { value.membership.validFrom = '0000-01-01T00:00:00.000Z'; }],
        ['duplicate roles', value => { value.membership.roles = ['admin', 'admin']; }],
        ['unsupported role', value => { value.membership.roles = ['operator']; }],
        ['empty role set', value => { value.membership.roles = []; }],
        ['implicit binding ID', value => { delete value.bindingId; }]
    ])('rejects %s without filling authority defaults', (_, change) => {
        const value = clone(template()); change(value);
        rejected(() => domain.normaliseTemplate(value));
    });

    test('existing-organisation template rejects bootstrap replacement state', () => {
        rejected(() => domain.normaliseTemplate({ ...template('existing_organisation'), bootstrap: template().bootstrap }), 'onboarding_input_invalid');
    });

    test('does not invoke accessors, toJSON or Proxy hooks during snapshot validation', () => {
        let invoked = 0;
        const getter = template();
        Object.defineProperty(getter.membership, 'roles', { enumerable: true, get() { invoked++; return ['admin']; } });
        rejected(() => domain.normaliseTemplate(getter), 'onboarding_input_invalid');
        const toJson = template(); toJson.toJSON = () => { invoked++; return template(); };
        rejected(() => domain.normaliseTemplate(toJson), 'onboarding_input_invalid');
        const proxy = new Proxy(template(), { ownKeys() { invoked++; throw new Error('private hook'); } });
        rejected(() => domain.normaliseTemplate(proxy), 'onboarding_input_invalid');
        assert.equal(invoked, 0);
    });

    test('rejects hidden/symbol authority, sparse lists and cycles', () => {
        const hidden = template(); Object.defineProperty(hidden, 'hidden', { value: true });
        const symbol = template(); symbol[Symbol('authority')] = true;
        const sparse = template(); sparse.membership.roles = new Array(1);
        const cycle = template(); cycle.scope = cycle;
        for (const value of [hidden, symbol, sparse, cycle]) rejected(() => domain.normaliseTemplate(value), 'onboarding_input_invalid');
    });

    test('canonical digest ignores object insertion order while preserving values and array order', () => {
        const a = { z: ['one', 'two'], a: { x: 1, b: true } };
        assert.equal(domain.canonicalDigest(a), domain.canonicalDigest({ a: { b: true, x: 1 }, z: ['one', 'two'] }));
        assert.notEqual(domain.canonicalDigest(a), domain.canonicalDigest({ ...a, z: ['two', 'one'] }));
    });
});

describe('POR010 first acceptance and original effect reconstruction', () => {
    test('bootstrap creates only the approved owner and original invite→accept effect', () => {
        const input = acceptanceInput(), before = clone(input), effect = domain.buildAcceptanceEffect(input);
        assert.deepEqual(input, before);
        assert.deepEqual(Object.keys(effect).sort(), ['schemaVersion', 'kind', 'scope', 'templateSha256',
            'acceptedAt', 'invitationExpiresAt', 'bindingId', 'predecessor', 'initialState'].sort());
        assert.equal(effect.predecessor, null);
        assert.equal(effect.acceptedAt, ACCEPTED);
        assert.equal(effect.invitationExpiresAt, APPROVAL_END);
        assert.equal(effect.templateSha256, domain.canonicalDigest(domain.normaliseTemplate(input.template)));
        assert.deepEqual(effect.initialState.membershipState, expectedMembership(input.template, null));
        assert.equal(effect.initialState.membershipState.revision, 2);
        const member = resolveActiveMembership(effect.initialState.membershipState, effect.initialState.tenantAggregate,
            { ...SCOPE, subjectKey: CUSTOMER }, ACCEPTED);
        assert.equal(member.createdAt, ACCEPTED);
        assert.equal(member.createdBy, CUSTOMER);
        assert.equal(effect.initialState.membershipState.invitations[0].createdBy, INITIATOR);
        assert.equal(Object.hasOwn(effect.initialState, 'usage'), false);
        assert.deepEqual(effect.initialState.entitlementState, normaliseEntitlementState(entitlement(), aggregate()));
        assert.equal(resolveEntitlements(effect.initialState.entitlementState, aggregate(), SCOPE, ACCEPTED, flags()).admissionGranted, false);
        deeplyFrozen(effect);
    });

    test('fresh bootstrap hashes and emits the actual DATA-canonical entitlement representation', () => {
        const selected = template(), product = selected.bootstrap.entitlementState.grants[0];
        product.grantId = 'z-synthetic-product'; product.modules = ['services', 'overview'];
        selected.bootstrap.entitlementState.grants.push({ ...SCOPE, grantId: 'a-synthetic-service',
            code: 'monthly_proof', status: 'active', validFrom: START, validUntil: END,
            agreementRef: 'synthetic-explicit-service', modules: ['services', 'overview'], frameworks: [],
            limits: {}, coverage: ['z-target', 'a-target'], actions: ['view', 'collect'] });
        const canonical = normaliseEntitlementState(selected.bootstrap.entitlementState, selected.bootstrap.tenantAggregate);
        assert.notDeepEqual(canonical, selected.bootstrap.entitlementState);
        const normalized = domain.normaliseTemplate(selected);
        assert.deepEqual(normalized.bootstrap.entitlementState, canonical);
        const input = acceptanceInput({ template: selected }), effect = domain.buildAcceptanceEffect(input);
        assert.deepEqual(effect.initialState.entitlementState, canonical);
        assert.equal(effect.templateSha256, domain.canonicalDigest(normalized));
        const retained = clone(effect); retained.initialState.entitlementState = clone(canonical);
        assert.deepEqual(domain.reconstructAcceptanceEffect(retained, reconstructionFacts(input)), effect);
    });

    test('existing organisation preserves the full predecessor and unrelated member while adding exactly two revisions', () => {
        const prior = predecessor(), selected = template('existing_organisation');
        const input = acceptanceInput({ template: selected, predecessor: prior });
        const effect = domain.buildAcceptanceEffect(input);
        assert.deepEqual(Object.keys(effect).sort(), ['schemaVersion', 'kind', 'scope', 'templateSha256',
            'acceptedAt', 'invitationExpiresAt', 'bindingId', 'predecessor', 'nextMembershipState'].sort());
        assert.deepEqual(effect.predecessor, prior);
        assert.deepEqual(effect.nextMembershipState, expectedMembership(selected, prior));
        assert.deepEqual(effect.nextMembershipState.memberships[0], prior.membershipState.memberships[0]);
        assert.equal(effect.nextMembershipState.revision, prior.membershipState.revision + 2);
        for (const key of ['tenantAggregate', 'entitlementState', 'flags', 'advisorAssignments']) {
            assert.deepEqual(effect.predecessor[key], prior[key]);
            assert.equal(Object.hasOwn(effect, key), false);
        }
        assert.equal(Object.hasOwn(effect, 'initialState'), false);
    });

    test('existing predecessor may retain another canonical organisation', () => {
        const prior = clone(predecessor());
        prior.tenantAggregate.organisations.push({ ...prior.tenantAggregate.organisations[0], organisationId: 'other-legitimate-org' });
        const input = acceptanceInput({ template: template('existing_organisation'), predecessor: prior });
        const effect = domain.buildAcceptanceEffect(input);
        assert.deepEqual(effect.predecessor.tenantAggregate, prior.tenantAggregate);
        resolveOrganisation(effect.predecessor.tenantAggregate, SCOPE);
        const reconstructed = domain.reconstructAcceptanceEffect(clone(effect), reconstructionFacts(input));
        assert.deepEqual(reconstructed, effect);
        assert.deepEqual(reconstructed.predecessor.membershipState.memberships, prior.membershipState.memberships);
        deeplyFrozen(reconstructed);
    });

    test('existing-organisation admission preserves explicitly approved non-admin roles', () => {
        const selected = template('existing_organisation'); selected.membership.roles = ['viewer'];
        const effect = domain.buildAcceptanceEffect(acceptanceInput({ template: selected, predecessor: predecessor() }));
        const member = effect.nextMembershipState.memberships.find(row => row.subjectKey === CUSTOMER);
        assert.deepEqual(member.roles, ['viewer']);
        assert.equal(member.roles.includes('admin'), false);
    });

    test('existing predecessor nonmembership representation remains exact while the member transition is added', () => {
        const prior = predecessor(); prior.entitlementState.grants[0].modules = ['services', 'overview'];
        const before = clone(prior), input = acceptanceInput({ template: template('existing_organisation'), predecessor: prior });
        const effect = domain.buildAcceptanceEffect(input);
        assert.deepEqual(effect.predecessor, before);
        assert.deepEqual(effect.predecessor.entitlementState.grants[0].modules, ['services', 'overview']);
        assert.deepEqual(domain.reconstructAcceptanceEffect(clone(effect), reconstructionFacts(input)), effect);
    });

    test.each([
        ['case deadline', { caseAcceptBefore: '2026-09-07T04:30:00.000Z', approvalAcceptBefore: CASE_END }, '2026-09-07T04:30:00.000Z'],
        ['approval deadline', {}, APPROVAL_END],
        ['membership end', { template: template('bootstrap', { membership: { ...template().membership, validUntil: '2026-09-07T04:30:00.000Z' } }) }, '2026-09-07T04:30:00.000Z']
    ])('retains the earliest %s as invitation expiry', (_, overrides, expected) => {
        const effect = domain.buildAcceptanceEffect(acceptanceInput(overrides));
        assert.equal(effect.invitationExpiresAt, expected);
        assert.equal(effect.initialState.membershipState.invitations[0].expiresAt, expected);
    });

    test('permits exact validFrom and the last millisecond before the acceptance deadline', () => {
        const atStart = acceptanceInput({ template: template('bootstrap', { membership: { ...template().membership, validFrom: ACCEPTED } }) });
        assert.equal(domain.buildAcceptanceEffect(atStart).acceptedAt, ACCEPTED);
        const last = acceptanceInput({ acceptedAt: '2026-09-07T04:59:59.999Z' });
        assert.equal(domain.buildAcceptanceEffect(last).acceptedAt, last.acceptedAt);
    });

    test.each([
        ['before membership starts', { template: template('bootstrap', { membership: { ...template().membership, validFrom: APPROVAL_END } }) }],
        ['at approval expiry', { acceptedAt: APPROVAL_END }],
        ['at case expiry', { acceptedAt: CASE_END, approvalAcceptBefore: END }],
        ['at membership expiry', { acceptedAt: END, caseAcceptBefore: END, approvalAcceptBefore: END }],
        ['after original deadlines', { acceptedAt: LATER }]
    ])('refuses a first acceptance %s', (_, overrides) => {
        rejected(() => domain.buildAcceptanceEffect(acceptanceInput(overrides)));
    });

    test('reconstruction preserves original acceptance after consumed deadlines while membership is still eligible', () => {
        const input = acceptanceInput(), effect = domain.buildAcceptanceEffect(input);
        const result = domain.reconstructAcceptanceEffect(clone(effect), reconstructionFacts(input));
        assert.deepEqual(result, effect);
        assert.equal(resolveActiveMembership(result.initialState.membershipState, result.initialState.tenantAggregate,
            { ...SCOPE, subjectKey: CUSTOMER }, LATER).createdAt, ACCEPTED);
        rejected(() => domain.buildAcceptanceEffect({ ...input, acceptedAt: LATER }));
    });

    test.each([
        ['new identity', value => { value.identity.oid = uuid(99); }],
        ['different initiator', value => { value.initiatorSubjectKey = OTHER; }],
        ['new role', value => { value.template.membership.roles = ['viewer']; }],
        ['new target', value => { value.template.scope.organisationId = 'changed-org'; }],
        ['extended approval', value => { value.approvalAcceptBefore = CASE_END; }]
    ])('retained effect rejects %s instead of rebuilding a changed acceptance', (_, change) => {
        const input = acceptanceInput(), effect = domain.buildAcceptanceEffect(input), facts = clone(reconstructionFacts(input));
        change(facts);
        rejected(() => domain.reconstructAcceptanceEffect(effect, facts), 'onboarding_record_invalid');
    });

    test('membership effect alone is not full identity-policy authority', () => {
        const input = acceptanceInput(), effect = domain.buildAcceptanceEffect(input);
        const facts = reconstructionFacts(input);
        facts.identity = identity({ policyRevision: 3 });
        assert.deepEqual(domain.reconstructAcceptanceEffect(effect, facts), effect);
        assert.notEqual(domain.canonicalDigest(input.identity), domain.canonicalDigest(facts.identity));
        // The separate original intent/receipt must bind that policy change;
        // no extra authority field is invented in the canonical effect union.
    });

    test.each([
        ['changed member answer authority', value => { value.initialState.membershipState.memberships[0].roles = ['viewer']; }],
        ['approval-time membership', value => { value.initialState.membershipState.memberships[0].createdAt = APPROVED; }],
        ['unrelated owner', value => { value.initialState.tenantAggregate.tenant.tenantId = 'foreign-tenant'; }],
        ['changed retained effect time', value => { value.acceptedAt = APPROVED; }],
        ['new usage field', value => { value.initialState.usage = []; }],
        ['invented binding', value => { value.bindingId = uuid(21); }]
    ])('rejects %s even when an outer record is freshly rehashed', (_, change) => {
        const input = acceptanceInput(), retained = clone(domain.buildAcceptanceEffect(input)); change(retained);
        assert.match(domain.canonicalDigest(retained), /^[0-9a-f]{64}$/);
        rejected(() => domain.reconstructAcceptanceEffect(retained, reconstructionFacts(input)), 'onboarding_record_invalid');
    });

    test('binds declared advisor grants only to the accepted member at original time', () => {
        const selected = template(); selected.membership.roles = ['admin', 'fractional_advisor'];
        selected.bootstrap.advisorGrants = [advisorGrant()];
        const effect = domain.buildAcceptanceEffect(acceptanceInput({ template: selected }));
        assert.deepEqual(effect.initialState.advisorAssignments, [normaliseAdvisorAssignment({ ...advisorGrant(),
            schemaVersion: 1, revision: 0, ...SCOPE, membershipId: selected.membership.membershipId,
            subjectKey: CUSTOMER, updatedAt: ACCEPTED })]);
        assert.equal(effect.initialState.entitlementState.grants.length, 1, 'advisor role must not purchase a service');
    });

    test.each([
        ['member substitution', { membershipId: 'foreign-member' }],
        ['subject substitution', { subjectKey: OTHER }],
        ['scope substitution', { tenantId: 'foreign-tenant' }],
        ['pre-membership validity', { validFrom: '2026-09-06T00:00:00.000Z' }],
        ['extended member validity', { validUntil: '2028-01-01T00:00:00.000Z' }]
    ])('rejects advisor %s', (_, overrides) => {
        const selected = template(); selected.bootstrap.advisorGrants = [advisorGrant(overrides)];
        rejected(() => domain.buildAcceptanceEffect(acceptanceInput({ template: selected })));
    });

    test('rejects malformed existing predecessor rather than filling missing canonical state', () => {
        for (const change of [value => { delete value.flags; }, value => { delete value.tenantAggregate.tenant.recordStatus; },
            value => { value.membershipState.organisationId = 'foreign'; }, value => { value.advisorAssignments = [normaliseAdvisorAssignment({
                ...advisorGrant(), schemaVersion: 1, ...SCOPE, membershipId: 'unknown', subjectKey: OTHER, revision: 0, updatedAt: START })]; }]) {
            const prior = clone(predecessor()); change(prior);
            rejected(() => domain.buildAcceptanceEffect(acceptanceInput({ template: template('existing_organisation'), predecessor: prior })));
        }
    });

    test('checks existing predecessor chronology and safe capacity for both membership transitions', () => {
        const later = clone(predecessor()); later.membershipState.updatedAt = LATER;
        rejected(() => domain.buildAcceptanceEffect(acceptanceInput({ template: template('existing_organisation'), predecessor: later })));
        const exhausted = clone(predecessor()); exhausted.membershipState.revision = Number.MAX_SAFE_INTEGER - 1;
        rejected(() => domain.buildAcceptanceEffect(acceptanceInput({ template: template('existing_organisation'), predecessor: exhausted })));
        const finalPair = clone(predecessor()); finalPair.membershipState.revision = Number.MAX_SAFE_INTEGER - 2;
        assert.equal(domain.buildAcceptanceEffect(acceptanceInput({ template: template('existing_organisation'), predecessor: finalPair })).nextMembershipState.revision,
            Number.MAX_SAFE_INTEGER);
    });

    test('a valid but different existing predecessor cannot support another retained result', () => {
        const input = acceptanceInput({ template: template('existing_organisation'), predecessor: predecessor() });
        const retained = clone(domain.buildAcceptanceEffect(input));
        retained.predecessor.membershipState = addMembership(retained.predecessor.membershipState,
            retained.predecessor.tenantAggregate, `${uuid(3)}:${uuid(7)}`, 'different-prior-invite', 'different-prior-member', START);
        normaliseMembershipState(retained.predecessor.membershipState);
        assert.match(domain.canonicalDigest(retained), /^[0-9a-f]{64}$/);
        rejected(() => domain.reconstructAcceptanceEffect(retained, reconstructionFacts(input)), 'onboarding_record_invalid');
    });
});

describe('POR010 explicit canonical byte limits', () => {
    test('the template itself accepts exactly 256 KiB and rejects the next canonical byte', () => {
        const selected = clone(template()), domains = selected.bootstrap.tenantAggregate.organisations[0].domains;
        const bytes = value => Buffer.byteLength(JSON.stringify(value));
        const limit = 256 * 1024;
        let index = 0;
        while (bytes(selected) + 243 <= limit - 10) {
            domains.push(`d${String(index++).padStart(4, '0')}.` + 'x'.repeat(229) + '.test');
        }
        const length = limit - bytes(selected) - 3;
        assert.ok(length >= 6 && length <= 253);
        domains.push('final-' + 'x'.repeat(length - 6));
        assert.equal(bytes(selected), limit);
        assert.equal(bytes(domain.normaliseTemplate(selected)), limit);
        domains[domains.length - 1] += 'x';
        assert.equal(bytes(selected), limit + 1);
        rejected(() => domain.normaliseTemplate(selected), 'onboarding_request_too_large');
    });

    test('whole-operation canonical hashing accepts exactly 512KiB and rejects one extra byte', () => {
        const empty = { padding: '' }, overhead = Buffer.byteLength(JSON.stringify(empty));
        const input = { padding: 'x'.repeat(512 * 1024 - overhead) };
        assert.equal(Buffer.byteLength(JSON.stringify(input)), 512 * 1024);
        assert.match(domain.canonicalDigest(input), /^[0-9a-f]{64}$/);
        rejected(() => domain.canonicalDigest({ padding: input.padding + 'x' }), 'onboarding_request_too_large');
    });

    test('a structurally valid large template is a definitive candidate413; retained excess is503', () => {
        const selected = clone(template());
        selected.bootstrap.tenantAggregate.organisations[0].domains = Array.from({ length: 1100 }, (_, index) =>
            `d${String(index).padStart(4, '0')}.${'a'.repeat(60)}.${'b'.repeat(60)}.${'c'.repeat(60)}.${'d'.repeat(45)}.test`);
        resolveOrganisation(selected.bootstrap.tenantAggregate, SCOPE);
        assert.ok(Buffer.byteLength(JSON.stringify(selected)) > 256 * 1024);
        assert.ok(Buffer.byteLength(JSON.stringify(selected)) < 512 * 1024);
        rejected(() => domain.normaliseTemplate(selected), 'onboarding_request_too_large');
        rejected(() => domain.buildAcceptanceEffect(acceptanceInput({ template: selected })), 'onboarding_request_too_large');
        const input = acceptanceInput(), retained = clone(domain.buildAcceptanceEffect(input));
        retained.initialState.tenantAggregate = selected.bootstrap.tenantAggregate;
        rejected(() => domain.reconstructAcceptanceEffect(retained, reconstructionFacts(input)), 'onboarding_record_invalid');
    });

    test('existing membership result growth is checked after valid predecessor construction', () => {
        const prior = predecessor();
        prior.entitlementState.grants[0].limits.memberships = 200;
        for (let index = 0; index < 120; index++) prior.membershipState = addMembership(prior.membershipState,
            prior.tenantAggregate, `${uuid(3)}:${uuid(1000 + index)}`, `retained-invitation-${index}`,
            `retained-member-${index}`, START);
        normaliseMembershipState(prior.membershipState);
        const input = acceptanceInput({ template: template('existing_organisation'), predecessor: prior });
        const projected = { predecessor: prior, nextMembershipState: expectedMembership(input.template, prior) };
        assert.ok(Buffer.byteLength(JSON.stringify(input)) < 256 * 1024);
        assert.ok(Buffer.byteLength(JSON.stringify(projected)) > 256 * 1024);
        rejected(() => domain.buildAcceptanceEffect(input), 'onboarding_request_too_large');
    });
});

describe('POR010 immutable identity proof and finite case lineage', () => {
    test('proof occurrence binds exact identity, scope, original case revision and authentication occurrence', () => {
        const input = proofInput(), proof = domain.createIdentityProof(input);
        assert.equal(proof.schemaVersion, 1);
        assert.equal(proof.subjectKey, CUSTOMER);
        assert.equal(proof.identitySha256, domain.canonicalDigest(input.identity));
        assert.deepEqual(proof.identity, input.identity);
        assert.equal(proof.caseId, input.caseId);
        assert.equal(proof.caseRevision, 0);
        assert.deepEqual(domain.normaliseIdentityProof(clone(proof)), proof);
        deeplyFrozen(proof);
        const again = domain.createIdentityProof({ ...input, proofId: uuid(60), operationId: uuid(61),
            authenticationSha256: 'd'.repeat(64), verifiedAt: APPROVED });
        assert.equal(again.identitySha256, proof.identitySha256);
        assert.notEqual(again.proofSha256, proof.proofSha256);
    });

    test.each([
        ['raw token field', value => { value.token = 'synthetic-not-a-token'; }],
        ['unsafe case revision', value => { value.caseRevision = Number.MAX_SAFE_INTEGER + 1; }],
        ['wrong digest format', value => { value.authenticationSha256 = 'ABC'; }],
        ['empty proof interval', value => { value.freshUntil = value.verifiedAt; }],
        ['year zero occurrence', value => { value.verifiedAt = '0000-01-01T00:00:00.000Z'; }]
    ])('rejects %s from a proof candidate', (_, change) => {
        const input = proofInput(); change(input);
        rejected(() => domain.createIdentityProof(input), 'onboarding_input_invalid');
    });

    test.each([
        ['mismatched subject', value => { value.subjectKey = OTHER; }],
        ['mismatched identity digest', value => { value.identitySha256 = 'e'.repeat(64); }],
        ['changed identity under old digest', value => { value.identity.oid = uuid(99); }],
        ['impossible freshness', value => { value.freshUntil = value.verifiedAt; }]
    ])('rejects rehashed retained proof with %s', (_, change) => {
        const proof = clone(domain.createIdentityProof(proofInput())); change(proof); rehash(proof, 'proofSha256');
        rejected(() => domain.normaliseIdentityProof(proof), 'onboarding_record_invalid');
    });

    test('create→bind→approve retains one original candidate and reconstructs its exact head', () => {
        const example = approvedCase();
        assert.equal(example.created.revision, 0);
        assert.equal(example.created.status, 'awaiting_identity');
        for (const key of ['candidateProof', 'approval', 'acceptanceReceipt', 'revocationEffect']) assert.equal(example.created[key], null);
        assert.equal(example.created.decisions.length, 1);
        assert.equal(example.created.decisions[0].parentSha256, null);
        assert.equal(example.bound.status, 'identity_verified');
        assert.equal(example.bound.revision, 1);
        assert.equal(example.approved.status, 'approved');
        assert.equal(example.approved.revision, 2);
        assert.deepEqual(example.approved.candidateProof, example.proof);
        assert.equal(example.approved.approval.candidateProofId, example.proof.proofId);
        assert.equal(example.approved.approval.identitySha256, example.proof.identitySha256);
        assert.equal(example.approved.approval.sha256, example.approved.decisions[2].sha256);
        assert.equal(example.approved.headSha256, example.approved.decisions[2].sha256);
        assert.deepEqual(domain.normaliseOnboardingState(clone(example.approved)), example.approved);
        deeplyFrozen(example.approved);
    });

    test('exact command retry after time advances preserves the current state, not a regenerated original head', () => {
        const example = approvedCase();
        assert.deepEqual(domain.applyOnboardingCommand(example.approved, { ...example.bindCommand, at: LATER }), example.approved);
        assert.deepEqual(domain.applyOnboardingCommand(example.approved, { ...example.approveCommand, at: LATER }), example.approved);
        const changed = clone(example.bindCommand); changed.actorSubjectKey = OTHER; changed.at = LATER;
        rejected(() => domain.applyOnboardingCommand(example.approved, changed), 'onboarding_conflict');
    });

    test.each([
        ['another case', { caseId: uuid(90) }],
        ['another tenant', { scope: { ...SCOPE, tenantId: 'foreign-tenant' } }],
        ['another organisation', { scope: { ...SCOPE, organisationId: 'foreign-org' } }],
        ['wrong parent revision', { caseRevision: 1 }]
    ])('cannot bind a valid proof of %s', (_, overrides) => {
        const state = domain.createOnboardingCase(caseInput()), proof = domain.createIdentityProof(proofInput(overrides));
        rejected(() => domain.applyOnboardingCommand(state, caseCommand(state, 'bind_identity', { proof },
            { at: VERIFIED, actorSubjectKey: CUSTOMER })));
        assert.equal(state.status, 'awaiting_identity');
    });

    test('approval cannot precede identity or replace a completed approval/candidate', () => {
        const example = approvedCase();
        rejected(() => domain.applyOnboardingCommand(example.created, caseCommand(example.created, 'approve',
            example.approveCommand.payload)), 'onboarding_conflict');
        rejected(() => domain.applyOnboardingCommand(example.approved, caseCommand(example.approved, 'approve',
            { ...example.approveCommand.payload, approvalId: uuid(70) }, { operationId: uuid(71), at: ACCEPTED })), 'onboarding_conflict');
        const later = domain.createIdentityProof(proofInput({ proofId: uuid(72), caseRevision: 2,
            operationId: uuid(73), authenticationSha256: 'f'.repeat(64), verifiedAt: APPROVED }));
        rejected(() => domain.applyOnboardingCommand(example.approved, caseCommand(example.approved, 'bind_identity',
            { proof: later }, { operationId: uuid(74), actorSubjectKey: CUSTOMER, at: ACCEPTED })), 'onboarding_conflict');
    });

    test('expires only at its retained deadline, and denied/expired cases cannot be revived', () => {
        const initial = domain.createOnboardingCase(caseInput());
        rejected(() => domain.applyOnboardingCommand(initial, caseCommand(initial, 'expire', {}, { at: APPROVED })));
        const expired = domain.applyOnboardingCommand(initial, caseCommand(initial, 'expire', {}, { at: CASE_END }));
        const denied = domain.applyOnboardingCommand(initial, caseCommand(initial, 'deny', { authorityRef: authorityRef() }));
        assert.equal(expired.status, 'expired'); assert.equal(denied.status, 'denied');
        for (const state of [expired, denied]) {
            assert.deepEqual(domain.normaliseOnboardingState(clone(state)), state);
            rejected(() => domain.applyOnboardingCommand(state, caseCommand(state, 'bind_identity',
                { proof: domain.createIdentityProof(proofInput({ caseRevision: state.revision })) },
                { operationId: uuid(75), actorSubjectKey: CUSTOMER, at: LATER })), 'onboarding_conflict');
        }
    });

    test('a rehashed state cannot invent a second bind after approval', () => {
        const example = approvedCase(), changed = clone(example.approved);
        const proof = domain.createIdentityProof(proofInput({ proofId: uuid(76), caseRevision: 2,
            identity: identity({ oid: uuid(77) }), operationId: uuid(78), authenticationSha256: '1'.repeat(64) }));
        const command = caseCommand(changed, 'bind_identity', { proof },
            { operationId: uuid(79), actorSubjectKey: `${uuid(3)}:${uuid(77)}`, at: ACCEPTED });
        const decision = rehash({ schemaVersion: 1, revision: 3, parentSha256: changed.headSha256, command }, 'sha256');
        changed.decisions.push(decision); changed.headSha256 = decision.sha256;
        changed.revision = 3; changed.updatedAt = ACCEPTED; changed.status = 'identity_verified'; changed.candidateProof = proof;
        rejected(() => domain.normaliseOnboardingState(changed), 'onboarding_record_invalid');
    });

    test('a valid hash chain still needs exact predecessor arithmetic and summary agreement', () => {
        const example = approvedCase();
        const summary = clone(example.approved); summary.scope.organisationId = 'foreign-org';
        rejected(() => domain.normaliseOnboardingState(summary), 'onboarding_record_invalid');
        const lineage = clone(example.approved); lineage.decisions[2].parentSha256 = lineage.decisions[0].sha256;
        rehash(lineage.decisions[2], 'sha256'); lineage.headSha256 = lineage.decisions[2].sha256;
        lineage.approval.sha256 = lineage.headSha256;
        rejected(() => domain.normaliseOnboardingState(lineage), 'onboarding_record_invalid');
    });
});

describe('POR010 original acceptance receipt and current reconciliation', () => {
    test.each(['bootstrap', 'existing_organisation'])('%s receipt retains original identity, case, proof, time and canonical effect', kind => {
        const selected = template(kind), prior = kind === 'bootstrap' ? null : predecessor();
        const example = acceptedCase(selected, prior), receipt = example.receipt;
        assert.deepEqual(Object.keys(receipt).sort(), ['schemaVersion', 'receiptId', 'operationId', 'caseId', 'scope',
            'intent', 'intentSha256', 'originalFacts', 'effect', 'effectSha256', 'receiptSha256'].sort());
        assert.deepEqual(receipt.originalFacts.caseState, example.approved);
        assert.deepEqual(receipt.originalFacts.proof, example.proof);
        assert.deepEqual(receipt.originalFacts.predecessor, prior);
        assert.equal(receipt.effect.acceptedAt, ACCEPTED);
        assert.equal(receipt.effect.invitationExpiresAt, APPROVAL_END);
        assert.equal(receipt.intentSha256, domain.canonicalDigest(receipt.intent));
        assert.equal(receipt.effectSha256, domain.canonicalDigest(receipt.effect));
        assert.deepEqual(domain.normaliseAcceptanceReceipt(clone(receipt)), receipt);
        assert.deepEqual(domain.assertAcceptanceIncluded(receipt, example.currentAuthority), receipt);
        assert.deepEqual(domain.normaliseOnboardingState(clone(example.accepted)), example.accepted);
        assert.equal(example.accepted.status, 'accepted'); assert.equal(example.accepted.revision, 3);
        assert.deepEqual(example.accepted.acceptanceReceipt, receipt);
        deeplyFrozen(receipt);
    });

    test('stable acceptance intent depends on original approved facts, not a new occurrence or request clock', () => {
        const example = acceptedCase();
        assert.deepEqual(domain.createAcceptanceIntent({ caseState: example.approved, operationId: uuid(39) }), example.receipt.intent);
        const proof = freshProof(example.accepted);
        assert.notEqual(proof.proofSha256, example.proof.proofSha256);
        assert.equal(proof.identitySha256, example.proof.identitySha256);
        const reconciled = domain.reconcileAcceptanceReceipt({ receipt: example.receipt, currentBinding: domain.createStagedIdentityBinding(example.receipt), caseState: example.accepted,
            proof, currentAuthority: example.currentAuthority, at: LATER });
        assert.deepEqual(reconciled, example.receipt);
        assert.equal(reconciled.effect.acceptedAt, ACCEPTED);
        assert.equal(reconciled.effect.invitationExpiresAt, APPROVAL_END);
        assert.deepEqual(example.accepted.candidateProof, example.proof);
        rejected(() => domain.createAcceptanceIntent({ caseState: example.approved, operationId: uuid(39), proof }), 'onboarding_input_invalid');
    });

    test.each([
        ['policy ID', { policyId: 'another-synthetic-policy' }],
        ['policy revision', { policyRevision: 3 }],
        ['issuer', { issuer: 'https://another.example.test/synthetic/v2.0' }],
        ['audience', { audience: 'another-client' }],
        ['identity tenant', { identityTenantId: uuid(90) }],
        ['object ID', { oid: uuid(91) }]
    ])('fresh proof with changed %s cannot disclose an original receipt', (_, overrides) => {
        const example = acceptedCase();
        const proof = freshProof(example.accepted, { identity: identity(overrides) });
        assert.notEqual(proof.identitySha256, example.proof.identitySha256);
        rejected(() => domain.reconcileAcceptanceReceipt({ receipt: example.receipt, currentBinding: domain.createStagedIdentityBinding(example.receipt), caseState: example.accepted,
            proof, currentAuthority: example.currentAuthority, at: LATER }), 'onboarding_access_denied');
    });

    test('rehashing a changed original policy proof cannot preserve the original acceptance receipt', () => {
        const example = acceptedCase(), retained = clone(example.receipt);
        const changed = domain.createIdentityProof({ ...proofInput(), identity: identity({ policyRevision: 3 }) });
        assert.equal(changed.subjectKey, example.proof.subjectKey);
        retained.originalFacts.proof = clone(changed); rehash(retained, 'receiptSha256');
        rejected(() => domain.normaliseAcceptanceReceipt(retained), 'onboarding_record_invalid');
    });

    test.each([
        ['wrong case', value => { value.caseId = uuid(92); }],
        ['wrong organisation', value => { value.scope.organisationId = 'another-org'; }],
        ['changed operation', value => { value.operationId = uuid(93); }],
        ['missing original proof', value => { delete value.originalFacts.proof; }],
        ['changed effect roles', value => { value.effect.initialState.membershipState.memberships[0].roles = ['viewer']; value.effectSha256 = domain.canonicalDigest(value.effect); }],
        ['lost original state', value => { value.originalFacts.caseState.decisions = []; }]
    ])('rejects a freshly rehashed receipt with %s', (_, change) => {
        const receipt = clone(acceptedCase().receipt); change(receipt); rehash(receipt, 'receiptSha256');
        rejected(() => domain.normaliseAcceptanceReceipt(receipt), 'onboarding_record_invalid');
    });

    test('first receipt requires approval chronology and a fresh proof at the actual acceptance time', () => {
        const example = approvedCase();
        const base = { receiptId: uuid(38), caseState: example.approved, proof: example.proof,
            operationId: uuid(39), acceptedAt: ACCEPTED, predecessor: null };
        rejected(() => domain.createAcceptanceReceipt({ ...base, acceptedAt: VERIFIED }));
        rejected(() => domain.createAcceptanceReceipt({ ...base, proof: domain.createIdentityProof(proofInput({ freshUntil: ACCEPTED })) }));
        rejected(() => domain.createAcceptanceReceipt({ ...base, proof: domain.createIdentityProof(proofInput({ verifiedAt: '2026-09-07T04:30:00.000Z' })) }));
    });

    test('expired or foreign-case current proof cannot reconcile, even with an exact receipt', () => {
        const example = acceptedCase();
        for (const overrides of [{ freshUntil: LATER, verifiedAt: APPROVED }, { caseId: uuid(94) },
            { scope: { ...SCOPE, tenantId: 'foreign-tenant' } }]) {
            const proof = freshProof(example.accepted, overrides);
            rejected(() => domain.reconcileAcceptanceReceipt({ receipt: example.receipt, currentBinding: domain.createStagedIdentityBinding(example.receipt), caseState: example.accepted,
                proof, currentAuthority: example.currentAuthority, at: LATER }), 'onboarding_access_denied');
        }
    });

    test('historical inclusion permits a legitimate later removal but current reconciliation denies it', () => {
        const example = acceptedCase(), current = clone(example.currentAuthority);
        current.membershipState = applyMembershipCommand(current.membershipState, current.tenantAggregate, { ...SCOPE,
            expectedRevision: current.membershipState.revision, actorSubjectKey: INITIATOR, now: LATER,
            action: 'remove', payload: { membershipId: template().membership.membershipId } });
        assert.deepEqual(domain.assertAcceptanceIncluded(example.receipt, current), example.receipt);
        rejected(() => domain.reconcileAcceptanceReceipt({ receipt: example.receipt, currentBinding: domain.createStagedIdentityBinding(example.receipt), caseState: example.accepted,
            proof: freshProof(example.accepted), currentAuthority: current, at: LATER }), 'onboarding_access_denied');
    });

    test('mixed restore and changed immutable member grant cannot pass retained effect inclusion', () => {
        const example = acceptedCase();
        const missing = clone(example.currentAuthority);
        missing.membershipState = createMembershipState(missing.tenantAggregate, SCOPE, START);
        rejected(() => domain.assertAcceptanceIncluded(example.receipt, missing), 'onboarding_record_invalid');
        const changed = clone(example.currentAuthority);
        changed.membershipState.invitations[0].grantEvidenceId = 'changed-evidence';
        changed.membershipState.memberships[0].grantEvidenceId = 'changed-evidence';
        normaliseMembershipState(changed.membershipState);
        rejected(() => domain.assertAcceptanceIncluded(example.receipt, changed), 'onboarding_record_invalid');
    });

    test('later legitimate member transitions do not rewrite or duplicate the original acceptance', () => {
        const example = acceptedCase(template('existing_organisation'), predecessor());
        const current = clone(example.currentAuthority);
        current.membershipState = addMembership(current.membershipState, current.tenantAggregate,
            `${uuid(3)}:${uuid(95)}`, 'later-invite', 'later-member', LATER);
        assert.deepEqual(domain.assertAcceptanceIncluded(example.receipt, current), example.receipt);
        assert.deepEqual(domain.reconcileAcceptanceReceipt({ receipt: example.receipt, currentBinding: domain.createStagedIdentityBinding(example.receipt), caseState: example.accepted,
            proof: freshProof(example.accepted), currentAuthority: current, at: LATER }), example.receipt);
        assert.equal(current.membershipState.memberships.filter(row => row.subjectKey === CUSTOMER).length, 1);
    });

    test('postacceptance revoke removes exactly the accepted member and retains the original receipt', () => {
        const example = acceptedCase(template('existing_organisation'), predecessor());
        const command = caseCommand(example.accepted, 'revoke', { authorityRef: authorityRef(), predecessor: example.currentAuthority },
            { operationId: uuid(96), at: LATER });
        const revoked = domain.applyOnboardingCommand(example.accepted, command);
        assert.equal(revoked.status, 'revoked'); assert.equal(revoked.revision, 4);
        assert.deepEqual(revoked.acceptanceReceipt, example.receipt);
        assert.deepEqual(Object.keys(revoked.revocationEffect).sort(), ['schemaVersion', 'bindingId', 'predecessor', 'nextMembershipState', 'revokedAt'].sort());
        assert.deepEqual(revoked.revocationEffect.predecessor, example.currentAuthority);
        assert.equal(revoked.revocationEffect.revokedAt, LATER);
        const expected = applyMembershipCommand(example.currentAuthority.membershipState, example.currentAuthority.tenantAggregate,
            { ...SCOPE, expectedRevision: example.currentAuthority.membershipState.revision, actorSubjectKey: INITIATOR,
                now: LATER, action: 'remove', payload: { membershipId: template().membership.membershipId } });
        assert.deepEqual(revoked.revocationEffect.nextMembershipState, expected);
        assert.deepEqual(expected.memberships.find(row => row.subjectKey === OTHER),
            example.currentAuthority.membershipState.memberships.find(row => row.subjectKey === OTHER));
        assert.deepEqual(domain.normaliseOnboardingState(clone(revoked)), revoked);
        rejected(() => domain.reconcileAcceptanceReceipt({ receipt: example.receipt, currentBinding: domain.createStagedIdentityBinding(example.receipt), caseState: revoked,
            proof: freshProof(revoked), currentAuthority: example.currentAuthority, at: LATER }), 'onboarding_access_denied');
    });
});

describe('POR010 explicit existing-member publication and typed bindings', () => {
    test('publishes exactly the named member without staged history or a membership mutation', () => {
        const input = publicationInput(), before = clone(input), receipt = domain.publishExistingMembershipBinding(input);
        assert.deepEqual(input, before);
        assert.equal(receipt.operationType, 'publish_existing_membership');
        assert.deepEqual(receipt.originalFacts.currentAuthority, before.currentAuthority);
        assert.equal(receipt.binding.origin, 'existing_membership');
        assert.equal(receipt.binding.publicationReceiptId, input.receiptId);
        assert.equal(receipt.binding.subjectKey, OTHER);
        assert.equal(receipt.binding.membershipId, input.membershipId);
        assert.equal(receipt.binding.invitationId, input.invitationId);
        assert.equal(receipt.binding.grantEvidenceId, input.grantEvidenceId);
        assert.equal(receipt.binding.organisationLabel, before.currentAuthority.tenantAggregate.organisations[0].displayName);
        for (const key of ['caseId', 'approvalId', 'approvalRevision', 'approvalSha256', 'acceptanceReceiptId']) assert.equal(receipt.binding[key], null);
        for (const key of ['membershipState', 'usage', 'caseState', 'proof']) assert.equal(Object.hasOwn(receipt, key), false);
        assert.deepEqual(domain.normalisePublicationReceipt(clone(receipt)), receipt);
        assert.deepEqual(domain.normaliseIdentityBinding(clone(receipt.binding)), receipt.binding);
        assert.deepEqual(domain.reconcilePublicationReceipt({ receipt, currentAuthority: input.currentAuthority,
            currentBinding: receipt.binding, at: LATER }), receipt);
        deeplyFrozen(receipt);
    });

    test('staged binding links the original accepted case and receipt without a publication receipt', () => {
        const example = acceptedCase(), binding = domain.createStagedIdentityBinding(example.receipt);
        assert.equal(binding.origin, 'staged_acceptance');
        assert.equal(binding.caseId, example.accepted.caseId);
        assert.equal(binding.approvalId, example.approved.approval.approvalId);
        assert.equal(binding.approvalRevision, example.approved.approval.revision);
        assert.equal(binding.approvalSha256, example.approved.approval.sha256);
        assert.equal(binding.acceptanceReceiptId, example.receipt.receiptId);
        assert.equal(binding.publicationReceiptId, null);
        assert.equal(binding.createdAt, ACCEPTED);
        assert.deepEqual(domain.normaliseIdentityBinding(clone(binding)), binding);
    });

    test.each([
        ['wrong member ID', { membershipId: 'another-member' }],
        ['wrong invitation', { invitationId: 'another-invitation' }],
        ['wrong grant evidence', { grantEvidenceId: 'another-evidence' }],
        ['wrong subject', { identity: identity() }],
        ['wrong tenant', { scope: { ...SCOPE, tenantId: 'another-tenant' } }],
        ['wrong organisation', { scope: { ...SCOPE, organisationId: 'another-org' } }],
        ['widened validity', { validUntil: '2028-01-01T00:00:00.000Z' }]
    ])('cannot publish %s', (_, overrides) => {
        const input = publicationInput(overrides), before = clone(input.currentAuthority);
        rejected(() => domain.publishExistingMembershipBinding(input));
        assert.deepEqual(input.currentAuthority, before);
    });

    test('existing member publication does not require or silently grant admin', () => {
        const input = publicationInput(), before = clone(input.currentAuthority.membershipState);
        assert.deepEqual(before.memberships[0].roles, ['viewer']);
        domain.publishExistingMembershipBinding(input);
        assert.deepEqual(input.currentAuthority.membershipState, before);
    });

    test('publication replay cannot resurrect a revoked binding or a removed member', () => {
        const input = publicationInput(), receipt = domain.publishExistingMembershipBinding(input);
        const revoked = domain.revokeIdentityBinding({ predecessor: receipt.binding, expectedRevision: 0,
            authorityRef: authorityRef(), at: LATER });
        assert.equal(revoked.revision, 1); assert.equal(revoked.status, 'revoked');
        assert.deepEqual(revoked.authorityRef, receipt.binding.authorityRef);
        rejected(() => domain.reconcilePublicationReceipt({ receipt, currentAuthority: input.currentAuthority,
            currentBinding: revoked, at: LATER }), 'onboarding_access_denied');
        const current = clone(input.currentAuthority);
        current.membershipState = applyMembershipCommand(current.membershipState, current.tenantAggregate, { ...SCOPE,
            expectedRevision: current.membershipState.revision, actorSubjectKey: INITIATOR, now: LATER,
            action: 'remove', payload: { membershipId: input.membershipId } });
        rejected(() => domain.reconcilePublicationReceipt({ receipt, currentAuthority: current,
            currentBinding: receipt.binding, at: LATER }), 'onboarding_access_denied');
    });

    test('binding revocation changes only status/revision/time and respects its current revision', () => {
        const binding = domain.publishExistingMembershipBinding(publicationInput()).binding;
        const revoked = domain.revokeIdentityBinding({ predecessor: binding, expectedRevision: 0,
            authorityRef: authorityRef({ revision: 3, sha256: '3'.repeat(64) }), at: LATER });
        assert.deepEqual(revoked, { ...binding, revision: 1, status: 'revoked', updatedAt: LATER });
        assert.deepEqual(domain.normaliseIdentityBinding(clone(revoked)), revoked);
        rejected(() => domain.revokeIdentityBinding({ predecessor: binding, expectedRevision: 1,
            authorityRef: authorityRef(), at: LATER }), 'onboarding_conflict');
    });

    test('a valid binding from another policy cannot be substituted into a rehashed publication receipt', () => {
        const input = publicationInput(), receipt = clone(domain.publishExistingMembershipBinding(input));
        const alternative = domain.publishExistingMembershipBinding({ ...input, identity: { ...input.identity, policyRevision: 3 } });
        domain.normaliseIdentityBinding(alternative.binding);
        receipt.binding = clone(alternative.binding); receipt.resultSha256 = alternative.resultSha256;
        rehash(receipt, 'receiptSha256');
        rejected(() => domain.normalisePublicationReceipt(receipt), 'onboarding_record_invalid');
    });

    test('binding discriminators reject mixed staged and publication references', () => {
        const existing = clone(domain.publishExistingMembershipBinding(publicationInput()).binding);
        existing.caseId = uuid(31);
        rejected(() => domain.normaliseIdentityBinding(existing), 'onboarding_record_invalid');
        const staged = clone(domain.createStagedIdentityBinding(acceptedCase().receipt));
        staged.publicationReceiptId = uuid(101);
        rejected(() => domain.normaliseIdentityBinding(staged), 'onboarding_record_invalid');
    });
});

describe('POR010 retained terminal-state inclusion', () => {
    test.each(['tenant name', 'organisation domains'])('retained owner history rejects changed %s at a higher revision', kind => {
        const example = acceptedCase(), current = clone(example.currentAuthority);
        if (kind === 'tenant name') {
            current.tenantAggregate.tenant.displayName = 'Substituted tenant label';
            current.tenantAggregate.tenant.revision += 2;
        } else {
            current.tenantAggregate.organisations[0].domains = ['substituted.example.test'];
            current.tenantAggregate.organisations[0].revision += 2;
        }
        resolveOrganisation(current.tenantAggregate, SCOPE);
        rejected(() => domain.assertAcceptanceIncluded(example.receipt, current), 'onboarding_record_invalid');
        rejected(() => domain.reconcileAcceptanceReceipt({ receipt: example.receipt, caseState: example.accepted,
            proof: freshProof(example.accepted), currentAuthority: current,
            currentBinding: domain.createStagedIdentityBinding(example.receipt), at: LATER }), 'onboarding_record_invalid');
    });

    test('retained owner history rejects revival of an originally closed sibling organisation', () => {
        const prior = predecessor(), sibling = { ...clone(prior.tenantAggregate.organisations[0]),
            organisationId: 'synthetic-closed-sibling' };
        prior.tenantAggregate = { ...prior.tenantAggregate, organisations: [...prior.tenantAggregate.organisations,
            transitionOrganisation(sibling, { expectedRevision: 0, toStatus: 'closed' })] };
        const example = acceptedCase(template('existing_organisation'), prior), current = clone(example.currentAuthority);
        assert.deepEqual(domain.assertAcceptanceIncluded(example.receipt, current), example.receipt);
        const closed = current.tenantAggregate.organisations.find(row => row.organisationId === sibling.organisationId);
        assert.throws(() => transitionOrganisation(closed, { expectedRevision: closed.revision, toStatus: 'active' }));
        closed.recordStatus = 'active'; closed.revision++;
        resolveOrganisation(current.tenantAggregate, { ...SCOPE, organisationId: sibling.organisationId });
        rejected(() => domain.assertAcceptanceIncluded(example.receipt, current), 'onboarding_record_invalid');
        rejected(() => domain.reconcileAcceptanceReceipt({ receipt: example.receipt, caseState: example.accepted,
            proof: freshProof(example.accepted), currentAuthority: current,
            currentBinding: domain.createStagedIdentityBinding(example.receipt), at: LATER }), 'onboarding_record_invalid');
    });

    test.each([['active', 1], ['suspended', 2]])('retained owner history rejects active to %s with impossible revision delta %i', (recordStatus, delta) => {
        const example = acceptedCase(), current = clone(example.currentAuthority);
        current.tenantAggregate.tenant = { ...current.tenantAggregate.tenant, recordStatus,
            revision: current.tenantAggregate.tenant.revision + delta };
        resolveOrganisation(current.tenantAggregate, SCOPE);
        rejected(() => domain.assertAcceptanceIncluded(example.receipt, current), 'onboarding_record_invalid');
        rejected(() => domain.reconcileAcceptanceReceipt({ receipt: example.receipt, caseState: example.accepted,
            proof: freshProof(example.accepted), currentAuthority: current,
            currentBinding: domain.createStagedIdentityBinding(example.receipt), at: LATER }), 'onboarding_record_invalid');
    });

    test.each(['tenant', 'organisation'])('retained owner history preserves actual %s suspend/resume/close transitions', kind => {
        const example = acceptedCase(), current = clone(example.currentAuthority);
        for (const toStatus of ['suspended', 'active', 'closed']) {
            if (kind === 'tenant') current.tenantAggregate.tenant = transitionTenant(current.tenantAggregate.tenant,
                { expectedRevision: current.tenantAggregate.tenant.revision, toStatus });
            else current.tenantAggregate.organisations[0] = transitionOrganisation(current.tenantAggregate.organisations[0],
                { expectedRevision: current.tenantAggregate.organisations[0].revision, toStatus });
            assert.deepEqual(domain.assertAcceptanceIncluded(example.receipt, current), example.receipt);
            const reconcile = () => domain.reconcileAcceptanceReceipt({ receipt: example.receipt, caseState: example.accepted,
                proof: freshProof(example.accepted), currentAuthority: current,
                currentBinding: domain.createStagedIdentityBinding(example.receipt), at: LATER });
            if (toStatus === 'active') assert.deepEqual(reconcile(), example.receipt);
            else rejected(reconcile, 'onboarding_access_denied');
        }
    });

    test('retained owner history permits a legitimate complete flags replacement at the next revision', () => {
        const example = acceptedCase(), current = clone(example.currentAuthority);
        current.flags = { ...current.flags, revision: current.flags.revision + 1,
            enabled: { dashboard: false, overview: false, services: true }, frameworks: [] };
        resolveEntitlements(current.entitlementState, current.tenantAggregate, SCOPE, LATER, current.flags);
        assert.deepEqual(domain.assertAcceptanceIncluded(example.receipt, current), example.receipt);
    });

    test.each(['changed entitlement limit', 'revoked entitlement revival', 'changed advisor evidence',
        'revoked advisor revival', 'backward advisor time'])('retained authority history rejects %s despite a valid higher-revision snapshot', kind => {
        const prior = predecessor();
        prior.advisorAssignments = [normaliseAdvisorAssignment({ ...advisorGrant(), schemaVersion: 1, ...SCOPE,
            membershipId: 'synthetic-unrelated-member', subjectKey: OTHER, revision: 0, updatedAt: CREATED })];
        if (kind === 'revoked entitlement revival') prior.entitlementState.grants[0].status = 'revoked';
        if (kind === 'revoked advisor revival') prior.advisorAssignments[0] =
            normaliseAdvisorAssignment({ ...prior.advisorAssignments[0], status: 'revoked' });
        const example = acceptedCase(template('existing_organisation'), prior);
        assert.deepEqual(domain.assertAcceptanceIncluded(example.receipt, example.currentAuthority), example.receipt);
        const current = clone(example.currentAuthority);
        if (kind.includes('entitlement')) {
            current.entitlementState.revision++;
            if (kind === 'changed entitlement limit') current.entitlementState.grants[0].limits.memberships++;
            else current.entitlementState.grants[0].status = 'active';
        } else {
            const assignment = current.advisorAssignments[0];
            assignment.revision++; assignment.updatedAt = LATER;
            if (kind === 'changed advisor evidence') assignment.grantEvidenceId = 'substituted-advisor-evidence';
            else if (kind === 'revoked advisor revival') assignment.status = 'active';
            else assignment.updatedAt = START;
        }
        normaliseEntitlementState(current.entitlementState, current.tenantAggregate);
        current.advisorAssignments.forEach(normaliseAdvisorAssignment);
        rejected(() => domain.assertAcceptanceIncluded(example.receipt, current), 'onboarding_record_invalid');
        rejected(() => domain.reconcileAcceptanceReceipt({ receipt: example.receipt, caseState: example.accepted,
            proof: freshProof(example.accepted), currentAuthority: current,
            currentBinding: domain.createStagedIdentityBinding(example.receipt), at: LATER }), 'onboarding_record_invalid');
    });

    test('retained authority history preserves legal grant suspension, resumption and revocation', () => {
        const example = acceptedCase(template('existing_organisation'), predecessor());
        const current = clone(example.currentAuthority);
        // DATA entitlement.update retains grant terms while allowing these status transitions.
        for (const status of ['suspended', 'active', 'revoked']) {
            current.entitlementState.revision++; current.entitlementState.grants[0].status = status;
            normaliseEntitlementState(current.entitlementState, current.tenantAggregate);
            assert.deepEqual(domain.assertAcceptanceIncluded(example.receipt, current), example.receipt);
            assert.deepEqual(domain.reconcileAcceptanceReceipt({ receipt: example.receipt, caseState: example.accepted,
                proof: freshProof(example.accepted), currentAuthority: current,
                currentBinding: domain.createStagedIdentityBinding(example.receipt), at: LATER }), example.receipt);
        }
    });

    test('retained authority history preserves advisor revocation and lawful unchanged revoked successors', () => {
        const selected = template(); selected.membership.roles = ['admin', 'fractional_advisor'];
        selected.bootstrap.advisorGrants = [advisorGrant()];
        const example = acceptedCase(selected), current = clone(example.currentAuthority);
        current.advisorAssignments[0] = normaliseAdvisorAssignment({ ...current.advisorAssignments[0],
            status: 'revoked', revision: 1, updatedAt: LATER });
        assert.deepEqual(domain.assertAcceptanceIncluded(example.receipt, current), example.receipt);
        assert.deepEqual(domain.reconcileAcceptanceReceipt({ receipt: example.receipt, caseState: example.accepted,
            proof: freshProof(example.accepted), currentAuthority: current,
            currentBinding: domain.createStagedIdentityBinding(example.receipt), at: LATER }), example.receipt);
        const revoked = predecessor(); revoked.advisorAssignments = [normaliseAdvisorAssignment({ ...advisorGrant(),
            schemaVersion: 1, ...SCOPE, membershipId: 'synthetic-unrelated-member', subjectKey: OTHER,
            status: 'revoked', revision: 1, updatedAt: CREATED })];
        const retained = acceptedCase(template('existing_organisation'), revoked);
        const successor = clone(retained.currentAuthority);
        successor.advisorAssignments[0] = normaliseAdvisorAssignment({ ...successor.advisorAssignments[0],
            revision: 2, updatedAt: LATER });
        assert.deepEqual(domain.assertAcceptanceIncluded(retained.receipt, successor), retained.receipt);
    });

    test.each(['removed member', 'revoked invitation', 'expired invitation'])('rejects higher-revision resurrection of an unrelated %s', kind => {
        const prior = terminalPredecessor(kind);
        normaliseMembershipState(prior.membershipState);
        const example = acceptedCase(template('existing_organisation'), prior);
        assert.deepEqual(domain.assertAcceptanceIncluded(example.receipt, example.currentAuthority), example.receipt);
        const current = clone(example.currentAuthority), state = current.membershipState;
        const row = kind === 'removed member'
            ? state.memberships.find(value => value.membershipId === 'synthetic-unrelated-member')
            : state.invitations.find(value => value.invitationId === 'synthetic-terminal-invite');
        assert.equal(row.status, kind.split(' ')[0]);
        row.status = kind === 'removed member' ? 'active' : 'pending';
        row.updatedAt = LATER; row.updatedBy = INITIATOR;
        state.revision++; state.updatedAt = LATER;
        normaliseMembershipState(state); // Valid snapshot shape still has impossible retained lineage.
        rejected(() => domain.assertAcceptanceIncluded(example.receipt, current), 'onboarding_record_invalid');
        rejected(() => domain.reconcileAcceptanceReceipt({ receipt: example.receipt, currentBinding: domain.createStagedIdentityBinding(example.receipt), caseState: example.accepted,
            proof: freshProof(example.accepted), currentAuthority: current, at: LATER }), 'onboarding_record_invalid');
    });

    test('retained pending invitation null membership remains lawful and a later expiry is preserved', () => {
        const prior = terminalPredecessor('expired invitation');
        assert.equal(prior.membershipState.invitations.find(row => row.invitationId === 'synthetic-terminal-invite').membershipId, null);
        const example = acceptedCase(template('existing_organisation'), prior);
        const invitation = example.currentAuthority.membershipState.invitations.find(row => row.invitationId === 'synthetic-terminal-invite');
        assert.equal(invitation.status, 'expired'); assert.equal(invitation.membershipId, null);
        assert.deepEqual(domain.normaliseAcceptanceReceipt(clone(example.receipt)), example.receipt);
        assert.deepEqual(domain.assertAcceptanceIncluded(example.receipt, example.currentAuthority), example.receipt);
    });

    test('legitimate suspend then resume remains historically included and currently eligible', () => {
        const example = acceptedCase(), current = clone(example.currentAuthority);
        for (const action of ['suspend', 'resume']) current.membershipState = applyMembershipCommand(current.membershipState,
            current.tenantAggregate, { ...SCOPE, expectedRevision: current.membershipState.revision,
                actorSubjectKey: INITIATOR, now: LATER, action, payload: { membershipId: template().membership.membershipId } });
        assert.deepEqual(domain.assertAcceptanceIncluded(example.receipt, current), example.receipt);
        assert.deepEqual(domain.reconcileAcceptanceReceipt({ receipt: example.receipt, currentBinding: domain.createStagedIdentityBinding(example.receipt), caseState: example.accepted,
            proof: freshProof(example.accepted), currentAuthority: current, at: LATER }), example.receipt);
    });

    test.each([
        ['active revision2', { status: 'active', revision: 2, updatedAt: LATER }],
        ['revoked revision0', { status: 'revoked', revision: 0, updatedAt: LATER }],
        ['revoked revision2', { status: 'revoked', revision: 2, updatedAt: LATER }]
    ])('rejects impossible binding %s rather than accepting a higher counter as lineage', (_, change) => {
        const input = publicationInput(), receipt = domain.publishExistingMembershipBinding(input);
        const impossible = { ...clone(receipt.binding), ...change };
        rejected(() => domain.normaliseIdentityBinding(impossible), 'onboarding_record_invalid');
        rejected(() => domain.reconcilePublicationReceipt({ receipt, currentAuthority: input.currentAuthority,
            currentBinding: impossible, at: LATER }), 'onboarding_record_invalid');
    });
});

describe('POR010 pure admission decisions and immutable transition receipts', () => {
    test('explicit publish→withdraw→new publish reconstructs exact scoped predecessor decisions', () => {
        const first = admissionReceipt(), second = admissionReceipt(first.result.record, 'withdrawAdmissionDecision', 160, APPROVED);
        const third = admissionReceipt(second.result.record, 'publishAdmissionDecision', 170, ACCEPTED);
        assert.equal(first.result.outcome, 'published'); assert.equal(second.result.outcome, 'withdrawn');
        assert.equal(third.result.record.payload.decision, 'eligible');
        assert.equal(first.result.record.revision, 0); assert.equal(first.result.record.parentRevision, null);
        assert.equal(first.result.record.parentSha256, null);
        assert.equal(second.result.record.parentRevision, 0);
        assert.equal(second.result.record.parentSha256, first.result.record.decisionSha256);
        assert.deepEqual(domain.normaliseAdmissionRecord(clone(third.result.record)), third.result.record);
        assert.deepEqual(domain.normaliseTransitionReceipt(clone(second)), second);
        assert.deepEqual(domain.assertTransitionIncluded({ receipt: first, currentRecord: third.result.record,
            successorReceipts: [second, third] }), first);
        const current = clone(third.result.record);
        assert.deepEqual(domain.replayTransitionReceipt({ receipt: first, command: first.stableIntent,
            currentRecord: current, successorReceipts: [second, third] }), first.result);
        assert.deepEqual(current, third.result.record, 'historical replay must not replace the newer admission head');
        deeplyFrozen(third);
    });

    test('original receipt replay conflicts on changed command identity, operation or scope', () => {
        const receipt = admissionReceipt();
        for (const change of [value => { value.actorSubjectKey = OTHER; }, value => { value.operationId = uuid(199); },
            value => { value.payload.target.organisationId = 'foreign'; }]) {
            const command = clone(receipt.stableIntent); change(command);
            rejected(() => domain.replayTransitionReceipt({ receipt, command, currentRecord: receipt.result.record,
                successorReceipts: [] }), 'onboarding_conflict');
        }
    });

    test('a higher admission revision cannot substitute for missing or forked predecessor history', () => {
        const first = admissionReceipt(), second = admissionReceipt(first.result.record, 'withdrawAdmissionDecision', 160, APPROVED);
        const third = admissionReceipt(second.result.record, 'publishAdmissionDecision', 170, ACCEPTED);
        rejected(() => domain.assertTransitionIncluded({ receipt: first, currentRecord: third.result.record,
            successorReceipts: [third] }), 'onboarding_record_invalid');
        const command = admissionCommand(first.result.record, 'withdrawAdmissionDecision', uuid(180));
        command.payload.validUntil = '2027-01-01T00:00:00.000Z';
        const fork = admissionReceipt(first.result.record, 'withdrawAdmissionDecision', 180, APPROVED, { command });
        rejected(() => domain.assertTransitionIncluded({ receipt: first, currentRecord: third.result.record,
            successorReceipts: [fork, third] }), 'onboarding_record_invalid');
    });

    test.each([
        ['receipt ID', 'original', 'receiptId'], ['audit event ID', 'original', 'auditEventId'],
        ['receipt ID', 'successor', 'receiptId'], ['audit event ID', 'successor', 'auditEventId']
    ])('duplicate %s against the %s receipt cannot establish retained lineage', (_, position, key) => {
        const first = admissionReceipt();
        const second = admissionReceipt(first.result.record, 'withdrawAdmissionDecision', 160, APPROVED,
            position === 'original' ? { [key]: first[key] } : {});
        const chain = [second];
        if (position === 'successor') chain.push(admissionReceipt(second.result.record, 'publishAdmissionDecision',
            170, ACCEPTED, { [key]: second[key] }));
        for (const row of chain) assert.deepEqual(domain.normaliseTransitionReceipt(clone(row)), row);
        rejected(() => domain.assertTransitionIncluded({ receipt: first,
            currentRecord: chain[chain.length - 1].result.record, successorReceipts: chain }), 'onboarding_record_invalid');
    });

    test('retained admission corruption stays503 at apply and receipt construction, while bad command stays400', () => {
        const first = admissionReceipt(), before = clone(first.result.record);
        before.decisionSha256 = 'f'.repeat(64);
        const command = admissionCommand(before, 'withdrawAdmissionDecision', uuid(180)), facts = { occurredAt: APPROVED };
        rejected(() => domain.normaliseAdmissionRecord(before), 'onboarding_record_invalid');
        rejected(() => domain.applyAdmissionCommand({ predecessor: before, command, facts }), 'onboarding_record_invalid');
        rejected(() => domain.createTransitionReceipt({ receiptId: uuid(181), auditEventId: uuid(182),
            predecessor: before, command, facts }), 'onboarding_record_invalid');
        rejected(() => domain.applyAdmissionCommand({ predecessor: null,
            command: { ...admissionCommand(), callback: () => true }, facts }), 'onboarding_input_invalid');
    });

    test('wrong-valid-result substitution fails after its outer receipt hashes are recomputed', () => {
        const receipt = clone(admissionReceipt()), command = clone(receipt.stableIntent);
        command.payload.identityPolicyRef.policyRevision = 3;
        const alternative = domain.applyAdmissionCommand({ predecessor: null, command, facts: receipt.originalFacts.facts });
        domain.normaliseAdmissionRecord(alternative.record);
        receipt.result = alternative; receipt.resultSha256 = domain.canonicalDigest(alternative); rehash(receipt, 'receiptSha256');
        rejected(() => domain.normaliseTransitionReceipt(receipt), 'onboarding_record_invalid');
    });

    test('admission enforces exact head, immutable scope, monotonic time and safe revision arithmetic', () => {
        const first = admissionReceipt(), before = first.result.record;
        const stale = admissionCommand(before, 'withdrawAdmissionDecision', uuid(180)); stale.expectedHeadSha256 = '9'.repeat(64);
        rejected(() => domain.applyAdmissionCommand({ predecessor: before, command: stale, facts: { occurredAt: APPROVED } }), 'onboarding_conflict');
        const changed = admissionCommand(before); changed.payload.target.organisationId = 'foreign';
        rejected(() => domain.applyAdmissionCommand({ predecessor: before, command: changed, facts: { occurredAt: APPROVED } }));
        rejected(() => domain.applyAdmissionCommand({ predecessor: before, command: admissionCommand(before), facts: { occurredAt: START } }));
        const limit = clone(before); limit.revision = Number.MAX_SAFE_INTEGER; limit.parentRevision = Number.MAX_SAFE_INTEGER - 1;
        limit.parentSha256 = '8'.repeat(64); rehash(limit, 'decisionSha256'); domain.normaliseAdmissionRecord(limit);
        rejected(() => domain.applyAdmissionCommand({ predecessor: limit, command: admissionCommand(limit), facts: { occurredAt: APPROVED } }), 'onboarding_conflict');
    });
});

describe('POR010 pure original issuance and session transitions', () => {
    test('initialization requires the supplied original issuance relationship and preserves a later selection', () => {
        const example = sessionFixture();
        assert.deepEqual(domain.normaliseOperatorIssuanceProof(clone(example.issuance)), example.issuance);
        const initialized = domain.applySessionCommand({ predecessor: null, command: example.command, facts: example.facts });
        assert.equal(initialized.outcome, 'initialized'); assert.equal(initialized.record.kind, 'operator_dashboard');
        assert.equal(initialized.record.parentSessionSha256, example.issuance.sessionSha256);
        assert.equal(initialized.record.operatorIssuanceSha256, domain.canonicalDigest(example.issuance));
        assert.equal(initialized.record.selectedBindingId, null);
        assert.equal(initialized.record.revision, 0); assert.equal(initialized.record.selectionGeneration, 0);
        const selected = domain.applySessionCommand(selectionInput(initialized.record, example.binding));
        const preserved = domain.applySessionCommand({ predecessor: selected.record, command: example.command,
            facts: { ...example.facts, occurredAt: ACCEPTED, generationToken: '7'.repeat(64) } });
        assert.equal(preserved.outcome, 'preserved'); assert.deepEqual(preserved.record, selected.record);
        assert.deepEqual(domain.normaliseSessionRecord(clone(selected.record)), selected.record);
        deeplyFrozen(preserved);
    });

    test.each(['sessionSha256', 'identitySha256', 'instanceId', 'restoreEpoch', 'issuedAt', 'expiresAt'])('original issuance mismatch in %s cannot initialize', key => {
        const example = sessionFixture(), issuance = clone(example.issuance);
        issuance[key] = key.endsWith('Sha256') ? 'a'.repeat(64) : key === 'instanceId' || key === 'restoreEpoch' ? uuid(299)
            : key === 'issuedAt' ? START : END;
        rejected(() => domain.applySessionCommand({ predecessor: null, command: example.command,
            facts: { ...example.facts, operatorIssuanceProof: issuance } }));
    });

    test('proofless absent-gate logout creates a permanent tombstone even after parent expiry', () => {
        const example = sessionFixture(), command = { schemaVersion: 1, operationType: 'revokeSession', operationId: uuid(220),
            sessionSha256: example.issuance.sessionSha256, actorSubjectKey: OTHER, payload: { seed: example.seed } };
        const tombstone = domain.applySessionCommand({ predecessor: null, command, facts: { occurredAt: LATER, generationToken: '8'.repeat(64) } });
        assert.equal(tombstone.outcome, 'tombstoned'); assert.equal(tombstone.record.status, 'revoked');
        assert.equal(tombstone.record.operatorIssuanceSha256, null); assert.equal(tombstone.record.revision, 0);
        assert.deepEqual(domain.normaliseSessionRecord(clone(tombstone.record)), tombstone.record);
        const repeated = domain.applySessionCommand({ predecessor: tombstone.record, command,
            facts: { occurredAt: '2026-09-08T00:01:00.000Z', generationToken: '9'.repeat(64) } });
        assert.equal(repeated.outcome, 'preserved'); assert.deepEqual(repeated.record, tombstone.record);
        rejected(() => domain.applySessionCommand({ predecessor: tombstone.record, command: example.command,
            facts: { ...example.facts, occurredAt: LATER } }), 'onboarding_access_denied');
        const early = domain.applySessionCommand({ predecessor: null, command,
            facts: { occurredAt: APPROVED, generationToken: '8'.repeat(64) } });
        rejected(() => domain.applySessionCommand({ predecessor: early.record, command: example.command,
            facts: { ...example.facts, occurredAt: ACCEPTED } }), 'onboarding_access_denied');
    });

    test('selection advances exact scope and token once; stale token or scalar preconditions cannot substitute', () => {
        const example = sessionFixture(), initial = domain.applySessionCommand({ predecessor: null, command: example.command, facts: example.facts }).record;
        const input = selectionInput(initial, example.binding), result = domain.applySessionCommand(input);
        assert.equal(result.outcome, 'selected'); assert.equal(result.record.revision, 1); assert.equal(result.record.selectionGeneration, 1);
        assert.equal(result.record.generationToken, input.facts.generationToken);
        assert.equal(result.record.selectedTenantId, example.binding.scope.tenantId);
        assert.equal(result.record.selectedOrganisationId, example.binding.scope.organisationId);
        assert.equal(result.record.selectedBindingId, example.binding.bindingId);
        for (const field of ['expectedRevision', 'expectedSelectionGeneration', 'expectedGeneration']) {
            const changed = clone(input); changed.command.payload[field] = field === 'expectedGeneration' ? 'a'.repeat(64) : 1;
            rejected(() => domain.applySessionCommand(changed), 'onboarding_conflict');
        }
        rejected(() => domain.applySessionCommand({ ...input, facts: { ...input.facts, generationToken: initial.generationToken } }));
    });

    test('session selection refuses expiry and changed binding identity and cannot overflow its safe counters', () => {
        const example = sessionFixture(), initial = domain.applySessionCommand({ predecessor: null, command: example.command, facts: example.facts }).record;
        const input = selectionInput(initial, example.binding);
        rejected(() => domain.applySessionCommand({ ...input, facts: { ...input.facts, occurredAt: APPROVAL_END } }), 'onboarding_access_denied');
        const foreign = domain.publishExistingMembershipBinding(publicationInput({ identity: identity({ oid: uuid(5), policyRevision: 3 }) })).binding;
        rejected(() => domain.applySessionCommand(selectionInput(initial, foreign)), 'onboarding_access_denied');
        const selected = domain.applySessionCommand(input).record;
        const penultimate = { ...clone(selected), revision: Number.MAX_SAFE_INTEGER - 1, selectionGeneration: Number.MAX_SAFE_INTEGER - 1 };
        const final = domain.applySessionCommand(selectionInput(penultimate, example.binding, '7'.repeat(64), uuid(221), ACCEPTED));
        assert.equal(final.record.revision, Number.MAX_SAFE_INTEGER);
        rejected(() => domain.applySessionCommand(selectionInput(final.record, example.binding, '8'.repeat(64), uuid(222), ACCEPTED)), 'onboarding_conflict');
    });

    test('revocation wins over later selection and historical receipt replay never reopens its record', () => {
        const example = sessionFixture();
        const first = domain.createTransitionReceipt({ receiptId: uuid(230), auditEventId: uuid(231), predecessor: null,
            command: example.command, facts: example.facts });
        const selectedInput = selectionInput(first.result.record, example.binding);
        const selected = domain.createTransitionReceipt({ receiptId: uuid(232), auditEventId: uuid(233), ...selectedInput });
        const command = { schemaVersion: 1, operationType: 'revokeSession', operationId: uuid(234),
            sessionSha256: example.issuance.sessionSha256, actorSubjectKey: OTHER, payload: { seed: example.seed } };
        const revoked = domain.createTransitionReceipt({ receiptId: uuid(235), auditEventId: uuid(236),
            predecessor: selected.result.record, command, facts: { occurredAt: LATER, generationToken: '8'.repeat(64) } });
        assert.equal(revoked.result.record.status, 'revoked'); assert.equal(revoked.result.record.revision, 2);
        assert.deepEqual(domain.assertTransitionIncluded({ receipt: first, currentRecord: revoked.result.record,
            successorReceipts: [selected, revoked] }), first);
        assert.deepEqual(domain.replayTransitionReceipt({ receipt: selected, command: selected.stableIntent,
            currentRecord: revoked.result.record, successorReceipts: [revoked] }), selected.result);
        assert.equal(revoked.result.record.status, 'revoked');
        rejected(() => domain.applySessionCommand(selectionInput(revoked.result.record, example.binding,
            '9'.repeat(64), uuid(237), LATER)), 'onboarding_access_denied');
    });

    test('retained session closure rejects incomplete scope and inconsistent counters', () => {
        const example = sessionFixture(), initial = domain.applySessionCommand({ predecessor: null, command: example.command, facts: example.facts }).record;
        const selected = domain.applySessionCommand(selectionInput(initial, example.binding)).record;
        for (const change of [value => { value.selectedOrganisationId = null; }, value => { value.selectionGeneration = 0; },
            value => { value.identitySha256 = 'a'.repeat(64); }, value => { value.operatorIssuanceSha256 = null; }]) {
            const current = clone(selected); change(current);
            rejected(() => domain.normaliseSessionRecord(current), 'onboarding_record_invalid');
        }
    });

    test('customer activation selects only the exact supplied full-identity binding and is not reissued by a new command', () => {
        const example = sessionFixture();
        const input = { predecessor: null, command: { schemaVersion: 1, operationType: 'activateCustomerSession',
            operationId: uuid(320), sessionSha256: 'a'.repeat(64), actorSubjectKey: OTHER,
            payload: { seed: example.seed, bindingId: example.binding.bindingId } },
            facts: { occurredAt: APPROVED, generationToken: 'b'.repeat(64), binding: example.binding } };
        const result = domain.applySessionCommand(input);
        assert.equal(result.outcome, 'activated'); assert.equal(result.record.kind, 'customer');
        assert.equal(result.record.parentSessionSha256, null); assert.equal(result.record.operatorIssuanceSha256, null);
        assert.equal(result.record.selectedBindingId, example.binding.bindingId);
        assert.equal(result.record.selectedOrganisationId, SCOPE.organisationId);
        assert.deepEqual(domain.normaliseSessionRecord(clone(result.record)), result.record);
        rejected(() => domain.applySessionCommand({ ...input, predecessor: result.record,
            command: { ...input.command, operationId: uuid(321) } }));
        const receipt = domain.createTransitionReceipt({ receiptId: uuid(322), auditEventId: uuid(323), ...input });
        assert.deepEqual(domain.normaliseTransitionReceipt(clone(receipt)), receipt);
    });

    test('discovery activation remains case/proof-bound and cannot select a resource or become a customer', () => {
        const example = sessionFixture(), proof = domain.createIdentityProof(proofInput({ identity: example.seed.identityPayload }));
        const input = { predecessor: null, command: { schemaVersion: 1, operationType: 'recordProofAndActivateDiscovery',
            operationId: uuid(330), sessionSha256: 'c'.repeat(64), actorSubjectKey: OTHER,
            payload: { seed: { ...example.seed, issuedAt: VERIFIED }, caseId: proof.caseId, proofId: proof.proofId } },
            facts: { occurredAt: APPROVED, generationToken: 'd'.repeat(64), proof } };
        const result = domain.applySessionCommand(input);
        assert.equal(result.outcome, 'activated'); assert.equal(result.record.kind, 'onboarding_discovery');
        assert.equal(result.record.discoveryCaseId, proof.caseId); assert.equal(result.record.discoveryProofId, proof.proofId);
        for (const key of ['selectedBindingId', 'selectedTenantId', 'selectedOrganisationId', 'parentSessionSha256', 'operatorIssuanceSha256']) {
            assert.equal(result.record[key], null);
        }
        assert.deepEqual(domain.normaliseSessionRecord(clone(result.record)), result.record);
        rejected(() => domain.applySessionCommand(selectionInput(result.record, example.binding, 'e'.repeat(64), uuid(331), ACCEPTED)), 'onboarding_access_denied');
        const selectedDiscovery = { ...clone(result.record), selectedBindingId: example.binding.bindingId,
            selectedTenantId: SCOPE.tenantId, selectedOrganisationId: SCOPE.organisationId };
        rejected(() => domain.normaliseSessionRecord(selectedDiscovery), 'onboarding_record_invalid');
        const receipt = domain.createTransitionReceipt({ receiptId: uuid(332), auditEventId: uuid(333), ...input });
        assert.deepEqual(domain.normaliseTransitionReceipt(clone(receipt)), receipt);
    });

    test.each(['operatorIssuanceProof', 'binding', 'proof'])('a retained %s exceeding its 16KiB record cap stays503 before the new-facts bound', key => {
        const example = sessionFixture();
        let input, field;
        if (key === 'operatorIssuanceProof') {
            input = { predecessor: null, command: example.command, facts: example.facts };
            field = 'identitySha256';
        } else if (key === 'binding') {
            const initial = domain.applySessionCommand({ predecessor: null, command: example.command, facts: example.facts }).record;
            input = selectionInput(initial, example.binding);
            field = 'organisationLabel';
        } else {
            const proof = domain.createIdentityProof(proofInput({ identity: example.seed.identityPayload }));
            input = { predecessor: null, command: { schemaVersion: 1, operationType: 'recordProofAndActivateDiscovery',
                operationId: uuid(345), sessionSha256: 'c'.repeat(64), actorSubjectKey: OTHER,
                payload: { seed: { ...example.seed, issuedAt: VERIFIED }, caseId: proof.caseId, proofId: proof.proofId } },
                facts: { occurredAt: APPROVED, generationToken: 'd'.repeat(64), proof } };
            field = 'authenticationSha256';
        }
        const stored = { ...clone(input.facts[key]), [field]: 'x'.repeat(17000) };
        const bad = { ...input, facts: { ...input.facts, [key]: stored } };
        rejected(() => domain.applySessionCommand(bad), 'onboarding_record_invalid');
        rejected(() => domain.createTransitionReceipt({ receiptId: uuid(346), auditEventId: uuid(347), ...bad }), 'onboarding_record_invalid');
    });

    test('nested retained session facts keep503 and never invoke getters or Proxy hooks', () => {
        const example = sessionFixture();
        const initial = domain.applySessionCommand({ predecessor: null, command: example.command, facts: example.facts }).record;
        const proof = domain.createIdentityProof(proofInput({ identity: example.seed.identityPayload }));
        const discovery = { predecessor: null, command: { schemaVersion: 1, operationType: 'recordProofAndActivateDiscovery',
            operationId: uuid(340), sessionSha256: 'c'.repeat(64), actorSubjectKey: OTHER,
            payload: { seed: { ...example.seed, issuedAt: VERIFIED }, caseId: proof.caseId, proofId: proof.proofId } },
            facts: { occurredAt: APPROVED, generationToken: 'd'.repeat(64), proof } };
        const examples = [
            [{ predecessor: null, command: example.command, facts: example.facts }, 'operatorIssuanceProof'],
            [selectionInput(initial, example.binding), 'binding'], [discovery, 'proof']
        ];
        let invoked = 0;
        for (const [input, key] of examples) {
            const getter = clone(input.facts[key]);
            Object.defineProperty(getter, 'schemaVersion', { enumerable: true, get() { invoked++; return 1; } });
            const proxy = new Proxy(input.facts[key], { ownKeys() { invoked++; throw new Error('private hook'); } });
            const oversized = { ...clone(input.facts[key]), padding: 'x'.repeat(512 * 1024) };
            for (const invalid of [getter, proxy, oversized]) {
                const bad = { ...input, facts: { ...input.facts, [key]: invalid } };
                rejected(() => domain.applySessionCommand(bad), 'onboarding_record_invalid');
                rejected(() => domain.createTransitionReceipt({ receiptId: uuid(341), auditEventId: uuid(342), ...bad }), 'onboarding_record_invalid');
            }
        }
        assert.equal(invoked, 0);
        rejected(() => domain.applySessionCommand({ predecessor: null, command: example.command,
            facts: { ...example.facts, generationToken: 'invalid-token' } }), 'onboarding_input_invalid');
    });
});

describe('POR010 exact current binding and immutable proof occurrences', () => {
    test('acceptance reconciliation refuses a valid revoked binding while original member remains active', () => {
        const example = acceptedCase(), currentBinding = domain.revokeIdentityBinding({
            predecessor: domain.createStagedIdentityBinding(example.receipt), expectedRevision: 0,
            authorityRef: authorityRef(), at: LATER });
        resolveActiveMembership(example.currentAuthority.membershipState, example.currentAuthority.tenantAggregate,
            { ...SCOPE, subjectKey: CUSTOMER }, LATER);
        rejected(() => domain.reconcileAcceptanceReceipt({ receipt: example.receipt, caseState: example.accepted,
            proof: freshProof(example.accepted), currentAuthority: example.currentAuthority, currentBinding,
            at: LATER }), 'onboarding_access_denied');
    });

    test.each([
        ['another binding', value => { value.bindingId = uuid(300); }],
        ['another receipt', value => { value.acceptanceReceiptId = uuid(301); }],
        ['another identity policy', value => { value.identity.policyRevision++; value.identitySha256 = domain.canonicalDigest(value.identity); }],
        ['another scope', value => { value.scope.organisationId = 'foreign-org'; }],
        ['publication origin', value => {
            value.origin = 'existing_membership'; value.publicationReceiptId = uuid(302);
            for (const key of ['caseId', 'approvalId', 'approvalRevision', 'approvalSha256', 'acceptanceReceiptId']) value[key] = null;
        }]
    ])('acceptance cannot substitute a well-formed current binding with %s', (_, change) => {
        const example = acceptedCase(), currentBinding = clone(domain.createStagedIdentityBinding(example.receipt));
        change(currentBinding); domain.normaliseIdentityBinding(currentBinding);
        rejected(() => domain.reconcileAcceptanceReceipt({ receipt: example.receipt, caseState: example.accepted,
            proof: freshProof(example.accepted), currentAuthority: example.currentAuthority, currentBinding,
            at: LATER }), 'onboarding_record_invalid');
    });

    test.each([
        ['candidate', 'proofId'], ['candidate', 'authenticationSha256'], ['candidate', 'operationId'],
        ['accepted', 'proofId'], ['accepted', 'authenticationSha256'], ['accepted', 'operationId']
    ])('fresh occurrence cannot reuse the original %s %s with changed retained facts', (originalKind, key) => {
        const atAcceptance = domain.createIdentityProof(proofInput({ proofId: uuid(310), operationId: uuid(311),
            caseRevision: 2, verifiedAt: APPROVED, authenticationSha256: '6'.repeat(64) }));
        const example = acceptedCase(template(), null, atAcceptance);
        const original = originalKind === 'candidate' ? example.proof : atAcceptance;
        const proof = freshProof(example.accepted, { [key]: original[key] });
        domain.normaliseIdentityProof(proof);
        assert.notEqual(proof.proofSha256, original.proofSha256);
        rejected(() => domain.reconcileAcceptanceReceipt({ receipt: example.receipt, caseState: example.accepted,
            proof, currentAuthority: example.currentAuthority, currentBinding: domain.createStagedIdentityBinding(example.receipt),
            at: LATER }), 'onboarding_access_denied');
    });
});
function deeplyFrozen(value) {
    if (!value || typeof value !== 'object') return;
    assert.equal(Object.isFrozen(value), true);
    for (const child of Object.values(value)) deeplyFrozen(child);
}
