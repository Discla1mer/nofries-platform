'use strict';

const assert = require('node:assert/strict');
// Runnable under the repository's Jest suite and dependency-free node --test.
const test = global.test || require('node:test');
const { createTenantAggregate, transitionTenant, transitionOrganisation } = require('../api/shared/appLifecycle/tenantDomain');
const { createMembershipState, normaliseMembershipState, applyMembershipCommand,
    resolveActiveMembership, MembershipDomainError } = require('../api/shared/appLifecycle/membershipDomain');

const ADMIN = '10000000-0000-4000-8000-000000000000:10000000-0000-4000-8000-000000000001';
const ALICE = '20000000-0000-4000-8000-000000000000:20000000-0000-4000-8000-000000000001';
const BOB = '20000000-0000-4000-8000-000000000000:20000000-0000-4000-8000-000000000002';
const START = '2026-09-05T00:00:00.000Z';
const ACCEPT = '2026-09-05T01:00:00.000Z';
const LATER = '2026-09-06T00:00:00.000Z';
const EXPIRES = '2026-09-07T00:00:00.000Z';
const END = '2027-09-05T00:00:00.000Z';
const SCOPE = { tenantId: 'tenant-a', organisationId: 'org-1' };
const clone = value => JSON.parse(JSON.stringify(value));
const tenant = (tenantId = 'tenant-a') => createTenantAggregate({
    tenant: { tenantId, displayName: 'Synthetic workspace' },
    organisations: [{ tenantId, organisationId: 'org-1', displayName: 'Synthetic one' },
        { tenantId, organisationId: 'org-2', displayName: 'Synthetic two' }]
});
const empty = (aggregate = tenant(), scope = SCOPE) => createMembershipState(aggregate, scope, START);
const grant = overrides => ({ invitationId: 'invite-1', subjectKey: ALICE,
    roles: ['viewer'], validFrom: START, validUntil: END, grantEvidenceId: 'grant-1',
    expiresAt: EXPIRES, ...overrides });
const command = (state, action, payload, overrides) => ({ ...SCOPE,
    expectedRevision: state.revision, actorSubjectKey: ADMIN, now: ACCEPT,
    action, payload, ...overrides });
const act = (state, action, payload, overrides, aggregate = tenant()) =>
    applyMembershipCommand(state, aggregate, command(state, action, payload, overrides));
const invited = overrides => act(empty(), 'invite', grant(overrides), { now: START });
const accepted = overrides => act(invited(overrides), 'accept',
    { invitationId: 'invite-1', membershipId: 'member-1' }, { actorSubjectKey: ALICE });
const resolve = (state, overrides, now = ACCEPT, aggregate = tenant()) =>
    resolveActiveMembership(state, aggregate, { ...SCOPE, subjectKey: ALICE, ...overrides }, now);
function rejects(fn, code, status) {
    assert.throws(fn, error => error instanceof MembershipDomainError &&
        error.code === `membership_${code}` && (!status || error.statusCode === status));
}

test('creates empty provider-free membership state bound to an existing organisation', () => {
    const state = empty();
    assert.equal(state.revision, 0);
    assert.deepEqual(state.invitations, []);
    assert.deepEqual(state.memberships, []);
    assert.equal(state.tenantId, SCOPE.tenantId);
    assert.equal(state.organisationId, SCOPE.organisationId);
    assert.ok(Object.isFrozen(state));
});

test('invite, accept, suspend, resume and remove form one tenant-bound lifecycle', () => {
    const i = invited({ roles: ['viewer', 'fractional_advisor'] });
    const a = act(i, 'accept', { invitationId: 'invite-1', membershipId: 'member-1' }, { actorSubjectKey: ALICE });
    assert.equal(a.revision, 2);
    assert.equal(a.invitations[0].status, 'accepted');
    assert.equal(a.invitations[0].membershipId, 'member-1');
    assert.deepEqual(resolve(a).roles, ['fractional_advisor', 'viewer']);
    assert.equal(resolve(a).grantEvidenceId, 'grant-1');
    const suspended = act(a, 'suspend', { membershipId: 'member-1' }, { now: LATER });
    rejects(() => resolve(suspended, {}, LATER), 'not_found', 404);
    const resumed = act(suspended, 'resume', { membershipId: 'member-1' }, { now: LATER });
    assert.equal(resolve(resumed, {}, LATER).status, 'active');
    const removed = act(resumed, 'remove', { membershipId: 'member-1' }, { now: LATER });
    assert.equal(removed.revision, 5);
    assert.equal(removed.memberships[0].status, 'removed');
    assert.equal(removed.invitations[0].status, 'accepted');
    rejects(() => resolve(removed, {}, LATER), 'not_found', 404);
    rejects(() => act(removed, 'resume', { membershipId: 'member-1' }, { now: LATER }), 'transition_not_allowed');
});

test('invitation acceptance is bound to immutable subject, not possession of an invitation ID', () => {
    const state = invited(), before = JSON.stringify(state);
    rejects(() => act(state, 'accept', { invitationId: 'invite-1', membershipId: 'member-1' },
        { actorSubjectKey: BOB }), 'not_found', 404);
    assert.equal(JSON.stringify(state), before);
});

test('accept payload cannot replace roles, subject, grant evidence or expiry', () => {
    for (const field of ['roles', 'subjectKey', 'grantEvidenceId', 'validUntil', 'tenantId']) {
        rejects(() => act(invited(), 'accept', { invitationId: 'invite-1', membershipId: 'member-1',
            [field]: field === 'roles' ? ['admin'] : 'forged' }, { actorSubjectKey: ALICE }), 'shape_invalid');
    }
});

for (const action of ['invite', 'accept', 'revoke', 'suspend', 'resume', 'remove']) {
    test(`${action} rejects both wrong tenant and wrong organisation before mutating state`, () => {
        const state = action === 'invite' ? empty() : action === 'accept' || action === 'revoke' ? invited() : accepted();
        const payload = action === 'invite' ? grant() : action === 'accept' ?
            { invitationId: 'invite-1', membershipId: 'member-1' } : action === 'revoke' ?
                { invitationId: 'invite-1' } : { membershipId: 'member-1' };
        const before = JSON.stringify(state);
        for (const overrides of [{ tenantId: 'tenant-b' }, { organisationId: 'org-2' }]) {
            rejects(() => act(state, action, payload, { actorSubjectKey: ALICE, ...overrides }), 'not_found', 404);
        }
        assert.equal(JSON.stringify(state), before);
    });
}

test('identical local IDs in two tenant aggregates never collide or transfer authority', () => {
    const a = accepted(), aggregateB = tenant('tenant-b'), scopeB = { ...SCOPE, tenantId: 'tenant-b' };
    let b = empty(aggregateB, scopeB);
    b = act(b, 'invite', grant({ subjectKey: BOB }), { ...scopeB, now: START }, aggregateB);
    b = act(b, 'accept', { invitationId: 'invite-1', membershipId: 'member-1' },
        { ...scopeB, actorSubjectKey: BOB }, aggregateB);
    assert.equal(resolve(a).subjectKey, ALICE);
    assert.equal(resolve(b, { ...scopeB, subjectKey: BOB }, ACCEPT, aggregateB).subjectKey, BOB);
    rejects(() => resolve(b, { ...scopeB, subjectKey: ALICE }, ACCEPT, aggregateB), 'not_found');
    rejects(() => resolve(a, scopeB, ACCEPT, aggregateB), 'not_found');
});

test('missing and other-tenant membership reads have the same safe error shape', () => {
    const errors = [{ tenantId: 'tenant-b' }, { organisationId: 'org-2' }, { subjectKey: BOB }].map(query => {
        try { resolve(accepted(), query); } catch (error) { return [error.statusCode, error.message, error.details]; }
    });
    assert.deepEqual(errors[0], errors[1]);
    assert.deepEqual(errors[1], errors[2]);
});

test('duplicate pending invitations reject both reused ID and another ID for the same subject', () => {
    const state = invited();
    rejects(() => act(state, 'invite', grant({ subjectKey: BOB })), 'invitation_duplicate');
    rejects(() => act(state, 'invite', grant({ invitationId: 'invite-2' })), 'invitation_duplicate');
});

test('expired invite acceptance fails at the exact expiry and after it', () => {
    for (const now of [EXPIRES, END]) {
        rejects(() => act(invited(), 'accept', { invitationId: 'invite-1', membershipId: 'member-1' },
            { actorSubjectKey: ALICE, now }), 'invitation_expired');
    }
});

test('a new invitation after expiry preserves history and cannot reuse the old ID', () => {
    const state = invited();
    rejects(() => act(state, 'invite', grant({ expiresAt: END }), { now: EXPIRES }), 'invitation_duplicate');
    const next = act(state, 'invite', grant({ invitationId: 'invite-2', expiresAt: END }), { now: EXPIRES });
    assert.equal(next.invitations[0].status, 'expired');
    assert.equal(next.invitations[1].status, 'pending');
    assert.equal(state.invitations[0].status, 'pending');
});

test('revoke leaves invitation history and prevents later acceptance', () => {
    const state = act(invited(), 'revoke', { invitationId: 'invite-1' });
    assert.equal(state.invitations[0].status, 'revoked');
    rejects(() => act(state, 'accept', { invitationId: 'invite-1', membershipId: 'member-1' },
        { actorSubjectKey: ALICE }), 'invitation_not_pending');
});

test('revocation at and after expiry rejects without relabelling expired invitation history', () => {
    const state = invited(), before = JSON.stringify(state);
    for (const now of [EXPIRES, END]) {
        rejects(() => act(state, 'revoke', { invitationId: 'invite-1' }, { now }), 'invitation_expired', 409);
        assert.equal(JSON.stringify(state), before);
    }
    const fresh = act(state, 'invite', grant({ invitationId: 'invite-2', expiresAt: END }), { now: EXPIRES });
    assert.equal(fresh.invitations[0].status, 'expired');
    assert.equal(fresh.invitations[1].status, 'pending');
});

test('rehydration rejects revoked invitation history timestamped at or after expiry', () => {
    const revoked = act(invited(), 'revoke', { invitationId: 'invite-1' });
    for (const now of [EXPIRES, END]) {
        const corrupt = clone(revoked);
        corrupt.updatedAt = now;
        corrupt.invitations[0].updatedAt = now;
        rejects(() => normaliseMembershipState(corrupt), 'invitation_invalid');
    }
});

test('replayed acceptance fails and never creates a second member', () => {
    const state = accepted();
    rejects(() => act(state, 'accept', { invitationId: 'invite-1', membershipId: 'member-2' },
        { actorSubjectKey: ALICE }), 'invitation_not_pending');
    assert.equal(state.memberships.length, 1);
});

test('active and suspended members cannot acquire another invitation', () => {
    const state = accepted();
    rejects(() => act(state, 'invite', grant({ invitationId: 'invite-2' })), 'subject_duplicate');
    const suspended = act(state, 'suspend', { membershipId: 'member-1' });
    rejects(() => act(suspended, 'invite', grant({ invitationId: 'invite-2' })), 'subject_duplicate');
});

test('re-invitation after removal creates fresh IDs and does not reactivate old membership', () => {
    let state = act(accepted(), 'remove', { membershipId: 'member-1' });
    state = act(state, 'invite', grant({ invitationId: 'invite-2' }));
    rejects(() => act(state, 'accept', { invitationId: 'invite-2', membershipId: 'member-1' },
        { actorSubjectKey: ALICE }), 'record_duplicate');
    state = act(state, 'accept', { invitationId: 'invite-2', membershipId: 'member-2' }, { actorSubjectKey: ALICE });
    assert.equal(state.memberships[0].status, 'removed');
    assert.equal(resolve(state).membershipId, 'member-2');
});

test('validity is half-open and requires explicit finite grant end', () => {
    const state = accepted({ validFrom: LATER });
    rejects(() => resolve(state), 'not_found');
    assert.equal(resolve(state, {}, LATER).status, 'active');
    rejects(() => resolve(state, {}, END), 'not_found');
    for (const validUntil of [null, undefined, START]) {
        assert.throws(() => invited({ validUntil }), MembershipDomainError);
    }
});

test('expired membership cannot be resumed but can be removed', () => {
    const suspended = act(accepted(), 'suspend', { membershipId: 'member-1' });
    rejects(() => act(suspended, 'resume', { membershipId: 'member-1' }, { now: END }), 'grant_expired');
    assert.equal(act(suspended, 'remove', { membershipId: 'member-1' }, { now: END }).memberships[0].status, 'removed');
});

for (const target of ['tenant', 'organisation']) {
    for (const status of ['suspended', 'closed']) {
        test(`${target} ${status} prevents creation, invitations, acceptance, resume and active lookup`, () => {
            const aggregate = clone(tenant());
            if (target === 'tenant') aggregate.tenant = transitionTenant(aggregate.tenant, { expectedRevision: 0, toStatus: status });
            else aggregate.organisations[0] = transitionOrganisation(aggregate.organisations[0], { expectedRevision: 0, toStatus: status });
            rejects(() => empty(aggregate), 'organisation_inactive');
            rejects(() => act(empty(), 'invite', grant(), {}, aggregate), 'organisation_inactive');
            rejects(() => act(invited(), 'accept', { invitationId: 'invite-1', membershipId: 'member-1' },
                { actorSubjectKey: ALICE }, aggregate), 'organisation_inactive');
            rejects(() => resolve(accepted(), {}, ACCEPT, aggregate), 'organisation_inactive');
            const suspended = act(accepted(), 'suspend', { membershipId: 'member-1' });
            rejects(() => act(suspended, 'resume', { membershipId: 'member-1' }, {}, aggregate), 'organisation_inactive');
            assert.equal(act(suspended, 'remove', { membershipId: 'member-1' }, {}, aggregate).memberships[0].status, 'removed');
        });
    }
}

test('stale, future and exhausted revisions fail without state mutation', () => {
    const state = invited(), before = JSON.stringify(state);
    for (const expectedRevision of [0, 2]) {
        rejects(() => act(state, 'revoke', { invitationId: 'invite-1' }, { expectedRevision }), 'revision_conflict');
    }
    rejects(() => act({ ...state, revision: Number.MAX_SAFE_INTEGER }, 'revoke',
        { invitationId: 'invite-1' }), 'revision_exhausted');
    assert.equal(JSON.stringify(state), before);
});

test('atomic repository compare-and-swap admits only one of two concurrent accept attempts', () => {
    // Test-only repository. A production adapter must provide this atomic contract.
    let stored = invited();
    const read = () => normaliseMembershipState(clone(stored));
    const cas = (expected, next) => {
        if (stored.revision !== expected) throw new Error('cas_conflict');
        assert.equal(next.revision, expected + 1);
        stored = normaliseMembershipState(next);
    };
    const left = read(), right = read();
    const first = act(left, 'accept', { invitationId: 'invite-1', membershipId: 'member-1' }, { actorSubjectKey: ALICE });
    const second = act(right, 'accept', { invitationId: 'invite-1', membershipId: 'member-2' }, { actorSubjectKey: ALICE });
    cas(left.revision, first);
    assert.throws(() => cas(right.revision, second), /cas_conflict/);
    assert.equal(stored.memberships.length, 1);
    assert.equal(stored.invitations[0].membershipId, 'member-1');
});

test('a time-regressing command or read cannot revive expired state', () => {
    const state = act(accepted(), 'suspend', { membershipId: 'member-1' }, { now: LATER });
    rejects(() => act(state, 'resume', { membershipId: 'member-1' }, { now: ACCEPT }), 'time_regression');
    rejects(() => resolve(state, {}, ACCEPT), 'time_regression');
});

test('canonical rehydration rejects every omitted or undefined aggregate field', () => {
    const canonical = accepted();
    for (const key of Object.keys(canonical)) {
        const missing = clone(canonical); delete missing[key];
        assert.throws(() => normaliseMembershipState(missing), MembershipDomainError);
        assert.throws(() => normaliseMembershipState({ ...canonical, [key]: undefined }), MembershipDomainError);
    }
});

test('canonical rehydration rejects every omitted or undefined invitation and membership field', () => {
    for (const collection of ['invitations', 'memberships']) {
        const canonical = accepted();
        for (const key of Object.keys(canonical[collection][0])) {
            for (const omit of [true, false]) {
                const broken = clone(canonical);
                if (omit) delete broken[collection][0][key]; else broken[collection][0][key] = undefined;
                assert.throws(() => normaliseMembershipState(broken), MembershipDomainError);
            }
        }
    }
});

test('rehydrated cross-tenant records and contradictory grants fail closed', () => {
    const corruptions = [
        state => { state.memberships[0].tenantId = 'tenant-b'; },
        state => { state.invitations[0].organisationId = 'org-2'; },
        state => { state.memberships[0].roles = ['admin']; },
        state => { state.memberships[0].grantEvidenceId = 'other'; },
        state => { state.memberships[0].subjectKey = BOB; },
        state => { state.invitations[0].membershipId = 'missing'; },
        state => { state.memberships[0].createdBy = ADMIN; },
        state => { state.invitations.push({ ...state.invitations[0], invitationId: 'other' }); },
        state => { state.memberships.push({ ...state.memberships[0], membershipId: 'other' }); }
    ];
    for (const corrupt of corruptions) {
        const state = clone(accepted()); corrupt(state);
        assert.throws(() => normaliseMembershipState(state), MembershipDomainError);
    }
});

test('plain-data validation rejects accessors without invoking them, inheritance, symbols and sparse arrays', () => {
    let calls = 0;
    const state = clone(accepted());
    Object.defineProperty(state, 'revision', { get() { calls += 1; return 2; } });
    rejects(() => normaliseMembershipState(state), 'shape_invalid');
    assert.equal(calls, 0);
    rejects(() => normaliseMembershipState(Object.create(accepted())), 'shape_invalid');
    rejects(() => normaliseMembershipState({ ...accepted(), [Symbol('extra')]: 1 }), 'shape_invalid');
    rejects(() => normaliseMembershipState({ ...accepted(), memberships: new Array(1) }), 'collection_invalid');
    const array = [accepted().memberships[0]];
    Object.defineProperty(array, '0', { get() { calls += 1; return {}; } });
    rejects(() => normaliseMembershipState({ ...accepted(), memberships: array }), 'collection_invalid');
    assert.equal(calls, 0);
});

test('identifiers, subjects, roles, timestamps, actions and revisions have strict validation', () => {
    for (const subjectKey of ['alice@example.test', 'Alice', 'A' + ALICE.slice(1), ' ' + ALICE, null]) {
        assert.throws(() => invited({ subjectKey }), MembershipDomainError);
    }
    for (const roles of [[], ['owner'], ['admin', 'admin'], null]) assert.throws(() => invited({ roles }), MembershipDomainError);
    for (const expiresAt of [START, '2026-02-30T00:00:00.000Z', '2026-09-07', '2026-09-07T00:00:00Z', '2028-01-01T00:00:00.000Z']) {
        assert.throws(() => invited({ expiresAt }), MembershipDomainError);
    }
    for (const invitationId of ['', ' id', 'id\n', null, 'x'.repeat(181)]) assert.throws(() => invited({ invitationId }), MembershipDomainError);
    for (const expectedRevision of [undefined, null, -1, 0.5, '0']) {
        rejects(() => act(empty(), 'invite', grant(), { expectedRevision }), 'revision_invalid');
    }
    rejects(() => act(empty(), 'promote', {}), 'action_invalid');
});

test('outputs are deeply frozen and input data is not aliased or mutated', () => {
    const payload = grant({ roles: ['editor'] }), state = empty();
    const result = act(state, 'invite', payload, { now: START });
    payload.roles.push('admin');
    assert.deepEqual(result.invitations[0].roles, ['editor']);
    assert.equal(state.invitations.length, 0);
    for (const value of [result, result.invitations, result.invitations[0], result.invitations[0].roles]) assert.ok(Object.isFrozen(value));
    assert.throws(() => { result.invitations[0].status = 'accepted'; }, TypeError);
});

test('same-state lifecycle transitions and missing records fail closed', () => {
    rejects(() => act(accepted(), 'resume', { membershipId: 'member-1' }), 'transition_not_allowed');
    const suspended = act(accepted(), 'suspend', { membershipId: 'member-1' });
    rejects(() => act(suspended, 'suspend', { membershipId: 'member-1' }), 'transition_not_allowed');
    const removed = act(accepted(), 'remove', { membershipId: 'member-1' });
    rejects(() => act(removed, 'remove', { membershipId: 'member-1' }), 'transition_not_allowed');
    rejects(() => act(accepted(), 'remove', { membershipId: 'absent' }), 'not_found');
    rejects(() => act(invited(), 'revoke', { invitationId: 'absent' }), 'not_found');
});
