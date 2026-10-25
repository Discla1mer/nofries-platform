'use strict';

const { resolveOrganisation } = require('./tenantDomain');

const SCHEMA_VERSION = 1;
const SUBJECT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ROLES = Object.freeze(['admin', 'editor', 'viewer', 'fractional_advisor']);
const INVITATION_STATUSES = Object.freeze(['pending', 'accepted', 'revoked', 'expired']);
const MEMBERSHIP_STATUSES = Object.freeze(['active', 'suspended', 'removed']);
const SCOPE_FIELDS = ['tenantId', 'organisationId'];
const GRANT_FIELDS = ['subjectKey', 'roles', 'validFrom', 'validUntil', 'grantEvidenceId'];
const INVITATION_FIELDS = [...SCOPE_FIELDS, ...GRANT_FIELDS, 'invitationId', 'status',
    'createdAt', 'createdBy', 'expiresAt', 'updatedAt', 'updatedBy', 'membershipId'];
const MEMBERSHIP_FIELDS = [...SCOPE_FIELDS, ...GRANT_FIELDS, 'membershipId', 'invitationId',
    'status', 'createdAt', 'createdBy', 'updatedAt', 'updatedBy'];

class MembershipDomainError extends Error {
    constructor(statusCode, code) {
        super(code);
        this.name = 'MembershipDomainError';
        this.statusCode = statusCode;
        this.code = code;
        this.details = Object.freeze({ code });
    }
}

function fail(code, statusCode = 400) {
    throw new MembershipDomainError(statusCode, `membership_${code}`);
}

// Only brand-new empty state gets defaults. All rehydrated fields are required.
function createMembershipState(tenantAggregate, selectorInput, now) {
    const scope = selector(selectorInput);
    assertOrganisation(tenantAggregate, scope, true);
    return freeze({ schemaVersion: SCHEMA_VERSION, ...scope, revision: 0,
        updatedAt: instant(now), invitations: [], memberships: [] });
}

function normaliseMembershipState(input) {
    const value = object(input, ['schemaVersion', ...SCOPE_FIELDS, 'revision',
        'updatedAt', 'invitations', 'memberships']);
    if (value.schemaVersion !== SCHEMA_VERSION) fail('schema_unsupported');
    const scope = scopeOf(value);
    const updatedAt = instant(value.updatedAt);
    const invitations = list(value.invitations).map(item => {
        const row = object(item, INVITATION_FIELDS);
        const grant = normaliseGrant(row);
        const createdAt = instant(row.createdAt);
        const expiresAt = instant(row.expiresAt);
        const changedAt = instant(row.updatedAt);
        if (!INVITATION_STATUSES.includes(row.status) || expiresAt <= createdAt ||
            expiresAt > grant.validUntil || changedAt < createdAt || changedAt > updatedAt ||
            (row.status === 'expired' && changedAt < expiresAt) ||
            (['accepted', 'revoked'].includes(row.status) && (changedAt >= expiresAt || changedAt >= grant.validUntil))) {
            fail('invitation_invalid');
        }
        if (row.status === 'accepted') identifier(row.membershipId);
        else if (row.membershipId !== null) fail('invitation_invalid');
        return { ...scopeOf(row), ...grant, invitationId: identifier(row.invitationId),
            status: row.status, createdAt, createdBy: subject(row.createdBy), expiresAt,
            updatedAt: changedAt, updatedBy: subject(row.updatedBy), membershipId: row.membershipId };
    });
    const memberships = list(value.memberships).map(item => {
        const row = object(item, MEMBERSHIP_FIELDS);
        const grant = normaliseGrant(row);
        const createdAt = instant(row.createdAt);
        const changedAt = instant(row.updatedAt);
        if (!MEMBERSHIP_STATUSES.includes(row.status) || createdAt >= grant.validUntil ||
            changedAt < createdAt || changedAt > updatedAt) fail('record_invalid');
        return { ...scopeOf(row), ...grant, membershipId: identifier(row.membershipId),
            invitationId: identifier(row.invitationId), status: row.status, createdAt,
            createdBy: subject(row.createdBy), updatedAt: changedAt, updatedBy: subject(row.updatedBy) };
    });
    const inviteIds = new Map(), memberIds = new Map(), currentSubjects = new Set();
    for (const row of [...invitations, ...memberships]) assertScope(row, scope);
    for (const row of invitations) {
        if (inviteIds.has(row.invitationId)) fail('invitation_duplicate', 409);
        inviteIds.set(row.invitationId, row);
    }
    for (const row of memberships) {
        if (memberIds.has(row.membershipId)) fail('record_duplicate', 409);
        memberIds.set(row.membershipId, row);
        if (row.status !== 'removed') {
            if (currentSubjects.has(row.subjectKey)) fail('subject_duplicate', 409);
            currentSubjects.add(row.subjectKey);
        }
        const invite = inviteIds.get(row.invitationId);
        if (!invite || invite.status !== 'accepted' || invite.membershipId !== row.membershipId ||
            invite.updatedAt !== row.createdAt || invite.updatedBy !== row.subjectKey ||
            row.createdBy !== row.subjectKey || !sameGrant(invite, row)) fail('grant_mismatch', 409);
    }
    const pendingSubjects = new Set();
    for (const row of invitations) {
        if (row.status === 'accepted') {
            const member = memberIds.get(row.membershipId);
            if (!member || member.invitationId !== row.invitationId || !sameGrant(row, member)) fail('grant_mismatch', 409);
        }
        if (row.status === 'pending' && row.expiresAt > updatedAt) {
            if (pendingSubjects.has(row.subjectKey) || currentSubjects.has(row.subjectKey)) {
                fail('invitation_duplicate', 409);
            }
            pendingSubjects.add(row.subjectKey);
        }
    }
    return freeze({ schemaVersion: SCHEMA_VERSION, ...scope, revision: revision(value.revision),
        updatedAt, invitations, memberships });
}

// These are domain commands for a trusted service, NOT an auth/authz boundary.
function applyMembershipCommand(stateInput, tenantAggregate, commandInput) {
    const command = object(commandInput, [...SCOPE_FIELDS, 'expectedRevision', 'actorSubjectKey',
        'now', 'action', 'payload']);
    const scope = scopeOf(command);
    const state = normaliseMembershipState(stateInput);
    assertScope(state, scope);
    const actions = ['invite', 'accept', 'revoke', 'suspend', 'resume', 'remove'];
    if (!actions.includes(command.action)) fail('action_invalid');
    assertOrganisation(tenantAggregate, scope, ['invite', 'accept', 'resume'].includes(command.action));
    if (revision(command.expectedRevision) !== state.revision) fail('revision_conflict', 409);
    if (!Number.isSafeInteger(state.revision + 1)) fail('revision_exhausted', 409);
    const now = instant(command.now), actor = subject(command.actorSubjectKey);
    if (now < state.updatedAt) fail('time_regression', 409);
    const next = { ...state, revision: state.revision + 1, updatedAt: now,
        invitations: state.invitations.map(row => ({ ...row })),
        memberships: state.memberships.map(row => ({ ...row })) };
    if (command.action === 'invite') {
        const payload = object(command.payload, ['invitationId', ...GRANT_FIELDS, 'expiresAt']);
        const invitationId = identifier(payload.invitationId), grant = normaliseGrant(payload);
        const expiresAt = instant(payload.expiresAt);
        if (expiresAt <= now || expiresAt > grant.validUntil || grant.validUntil <= now) fail('expiry_invalid');
        if (next.invitations.some(row => row.invitationId === invitationId)) fail('invitation_duplicate', 409);
        if (next.memberships.some(row => row.subjectKey === grant.subjectKey && row.status !== 'removed')) {
            fail('subject_duplicate', 409);
        }
        if (next.invitations.some(row => row.subjectKey === grant.subjectKey && row.status === 'pending' && row.expiresAt > now)) {
            fail('invitation_duplicate', 409);
        }
        // Expired invitation history is retained, never overwritten or reused.
        next.invitations = next.invitations.map(row => row.status === 'pending' && row.expiresAt <= now
            ? { ...row, status: 'expired', updatedAt: now, updatedBy: actor } : row);
        next.invitations.push({ ...scope, ...grant, invitationId, status: 'pending',
            createdAt: now, createdBy: actor, expiresAt, updatedAt: now, updatedBy: actor, membershipId: null });
    } else if (command.action === 'accept' || command.action === 'revoke') {
        const accepting = command.action === 'accept';
        const payload = object(command.payload, accepting ? ['invitationId', 'membershipId'] : ['invitationId']);
        const invitationId = identifier(payload.invitationId);
        const invite = next.invitations.find(row => row.invitationId === invitationId);
        if (!invite || (accepting && invite.subjectKey !== actor)) fail('not_found', 404);
        if (invite.status !== 'pending') fail('invitation_not_pending', 409);
        if (now >= invite.expiresAt || now >= invite.validUntil) fail('invitation_expired', 409);
        if (accepting) {
            const membershipId = identifier(payload.membershipId);
            if (next.memberships.some(row => row.membershipId === membershipId)) fail('record_duplicate', 409);
            if (next.memberships.some(row => row.subjectKey === actor && row.status !== 'removed')) fail('subject_duplicate', 409);
            next.memberships.push({ ...scope, ...normaliseGrant(invite), membershipId,
                invitationId, status: 'active', createdAt: now, createdBy: actor, updatedAt: now, updatedBy: actor });
            invite.status = 'accepted';
            invite.membershipId = membershipId;
        } else {
            invite.status = 'revoked';
        }
        invite.updatedAt = now;
        invite.updatedBy = actor;
    } else {
        const payload = object(command.payload, ['membershipId']);
        const membershipId = identifier(payload.membershipId);
        const member = next.memberships.find(row => row.membershipId === membershipId);
        if (!member) fail('not_found', 404);
        const targets = { suspend: ['active', 'suspended'], resume: ['suspended', 'active'] };
        if (command.action === 'remove') {
            if (member.status === 'removed') fail('transition_not_allowed', 409);
            member.status = 'removed';
        } else {
            const [from, to] = targets[command.action];
            if (member.status !== from) fail('transition_not_allowed', 409);
            if (command.action === 'resume' && now >= member.validUntil) fail('grant_expired', 409);
            member.status = to;
        }
        member.updatedAt = now;
        member.updatedBy = actor;
    }
    return normaliseMembershipState(next);
}

function resolveActiveMembership(stateInput, tenantAggregate, selectorInput, nowInput) {
    const query = object(selectorInput, [...SCOPE_FIELDS, 'subjectKey']);
    const scope = scopeOf(query), actor = subject(query.subjectKey), now = instant(nowInput);
    const state = normaliseMembershipState(stateInput);
    assertScope(state, scope);
    assertOrganisation(tenantAggregate, scope, true);
    if (now < state.updatedAt) fail('time_regression', 409);
    const member = state.memberships.find(row => row.subjectKey === actor && row.status === 'active' &&
        row.validFrom <= now && now < row.validUntil);
    if (!member) fail('not_found', 404);
    return member;
}

function assertOrganisation(aggregate, scope, requireActive) {
    const organisation = resolveOrganisation(aggregate, scope);
    if (requireActive && (organisation.recordStatus !== 'active' || aggregate.tenant.recordStatus !== 'active')) {
        fail('organisation_inactive', 409);
    }
}

function selector(input) { return scopeOf(object(input, SCOPE_FIELDS)); }
function scopeOf(row) { return { tenantId: identifier(row.tenantId), organisationId: identifier(row.organisationId) }; }
function assertScope(row, scope) {
    if (row.tenantId !== scope.tenantId || row.organisationId !== scope.organisationId) fail('not_found', 404);
}
function normaliseGrant(row) {
    const roles = list(row.roles);
    if (!roles.length || roles.some(role => !ROLES.includes(role)) || new Set(roles).size !== roles.length) fail('roles_invalid');
    const validFrom = instant(row.validFrom), validUntil = instant(row.validUntil);
    if (validUntil <= validFrom) fail('validity_invalid');
    return { subjectKey: subject(row.subjectKey), roles: roles.slice().sort(), validFrom,
        validUntil, grantEvidenceId: identifier(row.grantEvidenceId) };
}
function sameGrant(a, b) {
    return GRANT_FIELDS.every(key => key === 'roles'
        ? a.roles.length === b.roles.length && a.roles.every((role, i) => role === b.roles[i]) : a[key] === b[key]);
}
function object(value, fields) {
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
        ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail('shape_invalid');
    const descriptors = Object.getOwnPropertyDescriptors(value), keys = Reflect.ownKeys(value);
    if (keys.length !== fields.length || keys.some(key => !fields.includes(key)) ||
        fields.some(key => !Object.prototype.hasOwnProperty.call(descriptors, key) ||
            !Object.prototype.hasOwnProperty.call(descriptors[key], 'value'))) fail('shape_invalid');
    return Object.fromEntries(fields.map(key => [key, descriptors[key].value]));
}
function list(value) {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > 10000 ||
        Reflect.ownKeys(value).length !== value.length + 1) fail('collection_invalid');
    const output = [];
    for (let i = 0; i < value.length; i += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
        if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) fail('collection_invalid');
        output.push(descriptor.value);
    }
    return output;
}
function identifier(value) {
    if (typeof value !== 'string' || !value || value !== value.trim() || value.length > 180 || /[\u0000-\u001f\u007f]/.test(value)) fail('identifier_invalid');
    return value;
}
function subject(value) {
    if (typeof value !== 'string' || !SUBJECT.test(value)) fail('subject_invalid');
    return value;
}
function revision(value) {
    if (!Number.isSafeInteger(value) || value < 0) fail('revision_invalid');
    return value;
}
function instant(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) ||
        !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) fail('time_invalid');
    return value;
}
function freeze(value) {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
        Object.values(value).forEach(freeze);
        Object.freeze(value);
    }
    return value;
}

module.exports = { SCHEMA_VERSION, ROLES, MembershipDomainError, createMembershipState,
    normaliseMembershipState, applyMembershipCommand, resolveActiveMembership };
