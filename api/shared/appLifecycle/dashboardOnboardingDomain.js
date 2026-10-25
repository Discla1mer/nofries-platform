'use strict';

// Pure, deliberately uninstalled contracts. Validating these values does not
// authenticate a person, approve an effect or perform a durable mutation.
const { createHash } = require('node:crypto');
const { isProxy } = require('node:util').types;
const { resolveOrganisation, createTenantAggregate } = require('./tenantDomain');
const { createMembershipState, normaliseMembershipState, applyMembershipCommand,
    resolveActiveMembership } = require('./membershipDomain');
const { normaliseEntitlementState, resolveEntitlements } = require('./entitlementDomain');
const { normaliseAdvisorAssignment } = require('./portalPermissions');

const EFFECT_BYTES = 262144;
const OPERATION_BYTES = 524288;
const SMALL_BYTES = 16384;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const ROLES = ['admin', 'editor', 'viewer', 'fractional_advisor'];
const IDENTITY_FIELDS = ['policyId', 'policyRevision', 'issuer', 'identityTenantId', 'oid', 'audience'];
const AUTHORITY_FIELDS = ['tenantAggregate', 'membershipState', 'entitlementState', 'flags', 'advisorAssignments'];
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

class DashboardOnboardingError extends Error {
    constructor(code, statusCode) {
        super(code);
        this.name = 'DashboardOnboardingError';
        this.code = code;
        this.statusCode = statusCode;
    }
}
function fail(code = 'onboarding_input_invalid', status = 400) { throw new DashboardOnboardingError(code, status); }
function conflict() { fail('onboarding_conflict', 409); }
function denied() { fail('onboarding_access_denied', 403); }
function oversized() { fail('onboarding_request_too_large', 413); }
function retained(work) {
    try { return work(); } catch (_) { fail('onboarding_record_invalid', 503); }
}
function input(work) {
    try { return work(); } catch (error) {
        if (error instanceof DashboardOnboardingError) throw error;
        fail();
    }
}
function freeze(value) {
    if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
    return value;
}
function unicode(value) {
    for (let index = 0; index < value.length; index += 1) {
        const unit = value.charCodeAt(index);
        if (!unit || unit >= 0xdc00 && unit <= 0xdfff) fail();
        if (unit >= 0xd800 && unit <= 0xdbff) {
            const next = value.charCodeAt(++index);
            if (!(next >= 0xdc00 && next <= 0xdfff)) fail();
        }
    }
    return value;
}

// Inspect descriptors before reading data. No getters, proxies, toJSON hooks,
// sparse arrays, symbols, cycles or exotic prototypes participate in hashing.
function detach(value, maximum = OPERATION_BYTES) {
    const active = new Set();
    let bytes = 0;
    const count = amount => { bytes += amount; if (bytes > maximum) oversized(); };
    function visit(current, depth) {
        if (depth > 32) fail();
        if (current === null || typeof current === 'boolean') {
            count(current === null ? 4 : current ? 4 : 5); return current;
        }
        if (typeof current === 'string') {
            unicode(current); count(Buffer.byteLength(JSON.stringify(current))); return current;
        }
        if (typeof current === 'number') {
            if (!Number.isSafeInteger(current) || Object.is(current, -0)) fail();
            count(String(current).length); return current;
        }
        if (!current || typeof current !== 'object' || isProxy(current) || active.has(current)) fail();
        const array = Array.isArray(current);
        const prototype = Object.getPrototypeOf(current);
        if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) fail();
        active.add(current);
        const keys = Reflect.ownKeys(current);
        if (keys.some(key => typeof key !== 'string')) fail();
        let result;
        if (array) {
            const length = Object.getOwnPropertyDescriptor(current, 'length');
            if (!length || !own(length, 'value') || !Number.isSafeInteger(length.value) || length.value < 0 ||
                keys.length !== length.value + 1) fail();
            count(2 + Math.max(0, length.value - 1)); result = [];
            for (let index = 0; index < length.value; index += 1) {
                const field = Object.getOwnPropertyDescriptor(current, String(index));
                if (!field || !field.enumerable || !own(field, 'value')) fail();
                result.push(visit(field.value, depth + 1));
            }
        } else {
            const entries = []; count(2 + Math.max(0, keys.length - 1));
            for (const key of keys.sort()) {
                unicode(key);
                const field = Object.getOwnPropertyDescriptor(current, key);
                if (!field || !field.enumerable || !own(field, 'value')) fail();
                count(Buffer.byteLength(JSON.stringify(key)) + 1);
                entries.push([key, visit(field.value, depth + 1)]);
            }
            result = Object.fromEntries(entries);
        }
        active.delete(current); return result;
    }
    return visit(value, 0);
}
function canonicalDigest(value) {
    return createHash('sha256').update(JSON.stringify(detach(value))).digest('hex');
}
function same(left, right) { return canonicalDigest(left) === canonicalDigest(right); }
function record(value, fields) {
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
        Object.keys(value).length !== fields.length || fields.some(key => !own(value, key))) fail();
    return value;
}
function schema(value) { if (value !== 1) fail(); }
function identifier(value) {
    if (typeof value !== 'string' || !value || value.length > 180 || value.trim() !== value || /[\u0000-\u001f\u007f*]/.test(value)) fail();
    return unicode(value);
}
function uuid(value) { if (typeof value !== 'string' || !UUID.test(value)) fail(); return value; }
function digest(value) { if (typeof value !== 'string' || !DIGEST.test(value)) fail(); return value; }
function revision(value) { if (!Number.isSafeInteger(value) || value < 0 || Object.is(value, -0)) fail(); return value; }
function instant(value) {
    if (typeof value !== 'string' || !/^(?!0000)\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) ||
        !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) fail();
    return value;
}
function subject(value) {
    if (typeof value !== 'string' || value.length !== 73) fail();
    uuid(value.slice(0, 36)); if (value[36] !== ':') fail(); uuid(value.slice(37)); return value;
}
function scope(value) {
    record(value, ['tenantId', 'organisationId']); identifier(value.tenantId); identifier(value.organisationId); return value;
}
function equalScope(value, expected) {
    if (value.tenantId !== expected.tenantId || value.organisationId !== expected.organisationId) fail();
}
function subjectOf(identity) { return identity.identityTenantId + ':' + identity.oid; }
function identityValue(value) {
    record(value, IDENTITY_FIELDS); identifier(value.policyId); revision(value.policyRevision);
    uuid(value.identityTenantId); uuid(value.oid);
    for (const key of ['issuer', 'audience']) {
        if (typeof value[key] !== 'string' || !value[key] || value[key].trim() !== value[key] ||
            /[\u0000-\u001f\u007f]/.test(value[key]) || Buffer.byteLength(value[key]) > 1024) fail();
    }
    return value;
}
function normaliseStableIdentity(value) { return input(() => freeze(identityValue(detach(value, SMALL_BYTES)))); }
function membershipGrant(value) {
    record(value, ['invitationId', 'membershipId', 'roles', 'validFrom', 'validUntil', 'grantEvidenceId']);
    for (const key of ['invitationId', 'membershipId', 'grantEvidenceId']) identifier(value[key]);
    if (!Array.isArray(value.roles) || !value.roles.length || value.roles.some(role => !ROLES.includes(role)) ||
        new Set(value.roles).size !== value.roles.length) fail();
    value.roles.sort();
    if (instant(value.validFrom) >= instant(value.validUntil)) fail();
    return value;
}
function checkCanonicalScalars(value) {
    if (!value || typeof value !== 'object') return;
    for (const [key, field] of Object.entries(value)) {
        if (key === 'revision') revision(field);
        const unacceptedInvitation = key === 'membershipId' && field === null && own(value, 'invitationId') &&
            ['pending', 'revoked', 'expired'].includes(value.status);
        if (/^(?:tenantId|organisationId|membershipId|invitationId|grantId|assignmentId|grantEvidenceId)$/.test(key) &&
            !unacceptedInvitation) identifier(field);
        if (/^(?:createdAt|updatedAt|expiresAt|validFrom|validUntil)$/.test(key)) instant(field);
        if (key === 'subjectKey' || key === 'createdBy' || key === 'updatedBy') subject(field);
        if (field && typeof field === 'object') checkCanonicalScalars(field);
    }
}
function strictAuthority(value, expected) {
    record(value, AUTHORITY_FIELDS); checkCanonicalScalars(value);
    resolveOrganisation(value.tenantAggregate, expected);
    const membershipState = normaliseMembershipState(value.membershipState); equalScope(membershipState, expected);
    const entitlementState = normaliseEntitlementState(value.entitlementState, value.tenantAggregate); equalScope(entitlementState, expected);
    if (!value.flags) fail();
    resolveEntitlements(entitlementState, value.tenantAggregate, expected, '2000-01-01T00:00:00.000Z', value.flags);
    if (!Array.isArray(value.advisorAssignments)) fail();
    const assignments = value.advisorAssignments.map(normaliseAdvisorAssignment);
    if (new Set(assignments.map(row => row.assignmentId)).size !== assignments.length) fail();
    for (const assignment of assignments) {
        equalScope(assignment, expected);
        if (!membershipState.memberships.some(member => member.membershipId === assignment.membershipId &&
            member.subjectKey === assignment.subjectKey)) fail();
    }
    // Keep the strictly validated predecessor's representation and history.
    return value;
}
function advisorGrant(value) {
    record(value, ['assignmentId', 'status', 'validFrom', 'validUntil', 'modules', 'permissions', 'grantEvidenceId']);
    identifier(value.assignmentId); identifier(value.grantEvidenceId);
    if (!['active', 'revoked'].includes(value.status) || instant(value.validFrom) >= instant(value.validUntil) ||
        !Array.isArray(value.modules) || !Array.isArray(value.permissions)) fail();
    // Full permission vocabulary is checked using the actual member on construction.
    for (const values of [value.modules, value.permissions]) {
        if (new Set(values).size !== values.length) fail(); values.forEach(identifier); values.sort();
    }
    return value;
}
function templateValue(value) {
    const common = ['schemaVersion', 'kind', 'scope', 'membership', 'bindingId'];
    if (!value || !['bootstrap', 'existing_organisation'].includes(value.kind)) fail();
    record(value, value.kind === 'bootstrap' ? common.concat('bootstrap') : common);
    schema(value.schemaVersion); scope(value.scope); membershipGrant(value.membership); uuid(value.bindingId);
    if (value.kind === 'bootstrap') {
        const seed = record(value.bootstrap, ['tenantAggregate', 'entitlementState', 'flags', 'advisorGrants']);
        checkCanonicalScalars(seed);
        const organisation = resolveOrganisation(seed.tenantAggregate, value.scope);
        if (seed.tenantAggregate.organisations.length !== 1 || seed.tenantAggregate.tenant.revision !== 0 ||
            organisation.revision !== 0 || seed.tenantAggregate.tenant.recordStatus !== 'active' ||
            organisation.recordStatus !== 'active' || !value.membership.roles.includes('admin')) fail();
        const entitlement = normaliseEntitlementState(seed.entitlementState, seed.tenantAggregate);
        // DATA persists this canonical form; bind it before hashing a new seed.
        seed.entitlementState = entitlement;
        equalScope(entitlement, value.scope); if (!seed.flags) fail();
        resolveEntitlements(entitlement, seed.tenantAggregate, value.scope, '2000-01-01T00:00:00.000Z', seed.flags);
        if (!Array.isArray(seed.advisorGrants)) fail(); seed.advisorGrants.forEach(advisorGrant);
        if (new Set(seed.advisorGrants.map(row => row.assignmentId)).size !== seed.advisorGrants.length) fail();
        seed.advisorGrants.sort((a, b) => a.assignmentId < b.assignmentId ? -1 : a.assignmentId > b.assignmentId ? 1 : 0);
    }
    return value;
}
function normaliseTemplate(value) { return input(() => freeze(templateValue(detach(value, EFFECT_BYTES)))); }
// Fixed callers identify retained fields before detachment so corrupt stored
// facts cannot be reported as a repairable new command. This is private, not a
// caller-supplied schema or validator extension point.
function envelopeValues(value, fields) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || isProxy(value)) fail();
    const prototype = Object.getPrototypeOf(value), keys = Reflect.ownKeys(value);
    if (prototype !== Object.prototype && prototype !== null || keys.length !== fields.length ||
        keys.some(key => !fields.includes(key))) fail();
    return Object.fromEntries(fields.map(key => {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || !descriptor.enumerable || !own(descriptor, 'value')) fail();
        return [key, descriptor.value];
    }));
}
function candidateEnvelope(value, fields, retainedFields) {
    const supplied = envelopeValues(value, fields);
    const entries = fields.map(key => {
        const field = supplied[key];
        return [key, retainedFields.includes(key) && field !== null ? retained(() => detach(field, EFFECT_BYTES)) : field];
    });
    return detach(Object.fromEntries(entries));
}
function acceptanceFacts(value) {
    record(value, ['template', 'identity', 'initiatorSubjectKey', 'caseAcceptBefore', 'approvalAcceptBefore', 'acceptedAt', 'predecessor']);
    value.template = templateValue(value.template); value.identity = identityValue(value.identity);
    subject(value.initiatorSubjectKey); instant(value.caseAcceptBefore); instant(value.approvalAcceptBefore); instant(value.acceptedAt);
    const template = value.template;
    if (template.kind === 'bootstrap') { if (value.predecessor !== null) fail(); }
    else retained(() => strictAuthority(value.predecessor, template.scope));
    return value;
}
function effectFromFacts(value) {
    const facts = acceptanceFacts(value), template = facts.template, target = template.scope, grant = template.membership;
    const expiry = [facts.caseAcceptBefore, facts.approvalAcceptBefore, grant.validUntil].sort()[0];
    const at = facts.acceptedAt, customer = subjectOf(facts.identity);
    if (at < grant.validFrom || at >= grant.validUntil || at >= expiry) denied();
    const aggregate = template.kind === 'bootstrap' ? template.bootstrap.tenantAggregate : facts.predecessor.tenantAggregate;
    let membershipState = template.kind === 'bootstrap' ? createMembershipState(aggregate, target, at) : facts.predecessor.membershipState;
    if (membershipState.revision > Number.MAX_SAFE_INTEGER - 2) conflict();
    const invite = { invitationId: grant.invitationId, subjectKey: customer, roles: grant.roles,
        validFrom: grant.validFrom, validUntil: grant.validUntil, grantEvidenceId: grant.grantEvidenceId, expiresAt: expiry };
    membershipState = applyMembershipCommand(membershipState, aggregate, { ...target,
        expectedRevision: membershipState.revision, actorSubjectKey: facts.initiatorSubjectKey, now: at, action: 'invite', payload: invite });
    membershipState = applyMembershipCommand(membershipState, aggregate, { ...target,
        expectedRevision: membershipState.revision, actorSubjectKey: customer, now: at, action: 'accept',
        payload: { invitationId: grant.invitationId, membershipId: grant.membershipId } });
    const effect = { schemaVersion: 1, kind: template.kind, scope: target, templateSha256: canonicalDigest(template),
        acceptedAt: at, invitationExpiresAt: expiry, bindingId: template.bindingId };
    if (template.kind === 'bootstrap') {
        const seed = template.bootstrap;
        const assignments = seed.advisorGrants.map(row => {
            if (row.validFrom < grant.validFrom || row.validUntil > grant.validUntil) fail();
            return normaliseAdvisorAssignment({ ...row, schemaVersion: 1, revision: 0, ...target,
                membershipId: grant.membershipId, subjectKey: customer, updatedAt: at });
        });
        effect.predecessor = null;
        effect.initialState = { tenantAggregate: aggregate, membershipState, entitlementState: seed.entitlementState,
            flags: seed.flags, advisorAssignments: assignments };
        strictAuthority(effect.initialState, target);
    } else {
        effect.predecessor = facts.predecessor; effect.nextMembershipState = membershipState;
    }
    return freeze(detach(effect, EFFECT_BYTES));
}
function buildAcceptanceEffect(value) {
    return input(() => effectFromFacts(candidateEnvelope(value, ['template', 'identity', 'initiatorSubjectKey',
        'caseAcceptBefore', 'approvalAcceptBefore', 'acceptedAt', 'predecessor'], ['predecessor'])));
}
function reconstructAcceptanceEffect(effectInput, factsInput) {
    return retained(() => {
        const effect = detach(effectInput, EFFECT_BYTES), facts = detach(factsInput);
        record(facts, ['template', 'identity', 'initiatorSubjectKey', 'caseAcceptBefore', 'approvalAcceptBefore']);
        const expected = effectFromFacts({ ...facts, acceptedAt: effect.acceptedAt, predecessor: effect.predecessor });
        if (!same(effect, expected)) fail();
        return expected;
    });
}

function authorityRef(value) {
    record(value, ['authorityId', 'revision', 'sha256']); uuid(value.authorityId);
    revision(value.revision); digest(value.sha256); return value;
}
function nextAuthority(value, previous) {
    authorityRef(value);
    if (value.authorityId !== previous.authorityId || value.revision < previous.revision ||
        value.revision === previous.revision && value.sha256 !== previous.sha256) denied();
}
function proofFromFacts(value) {
    record(value, ['proofId', 'caseId', 'scope', 'caseRevision', 'identity', 'authenticationSha256',
        'verifiedAt', 'freshUntil', 'operationId']);
    uuid(value.proofId); uuid(value.caseId); scope(value.scope); revision(value.caseRevision);
    identityValue(value.identity); digest(value.authenticationSha256); uuid(value.operationId);
    if (instant(value.verifiedAt) >= instant(value.freshUntil)) fail();
    const proof = { schemaVersion: 1, ...value, subjectKey: subjectOf(value.identity),
        identitySha256: canonicalDigest(value.identity) };
    return freeze(detach({ ...proof, proofSha256: canonicalDigest(proof) }, SMALL_BYTES));
}
function createIdentityProof(value) { return input(() => proofFromFacts(detach(value, SMALL_BYTES))); }
function proofValue(value) {
    record(value, ['schemaVersion', 'proofId', 'caseId', 'scope', 'caseRevision', 'identity',
        'authenticationSha256', 'verifiedAt', 'freshUntil', 'operationId', 'subjectKey', 'identitySha256', 'proofSha256']);
    const { schemaVersion, subjectKey, identitySha256, proofSha256, ...facts } = value;
    schema(schemaVersion); subject(subjectKey); digest(identitySha256); digest(proofSha256);
    const expected = proofFromFacts(facts); if (!same(expected, value)) fail(); return expected;
}
function normaliseIdentityProof(value) { return retained(() => proofValue(detach(value, SMALL_BYTES))); }
function currentProof(proof, state, at, original = false) {
    if (proof.caseId !== state.caseId || !same(proof.scope, state.scope) || proof.caseRevision > state.revision ||
        proof.verifiedAt < state.createdAt || proof.verifiedAt > at || proof.freshUntil <= at) denied();
    if (original && proof.caseRevision !== state.revision) denied();
    if (state.candidateProof && !same(proof.identity, state.candidateProof.identity)) denied();
    const known = [state.candidateProof, state.acceptanceReceipt && state.acceptanceReceipt.originalFacts.proof].filter(Boolean);
    for (const occurrence of known) {
        if (proof.proofId === occurrence.proofId) {
            if (!same(proof, occurrence)) denied();
        } else if (proof.authenticationSha256 === occurrence.authenticationSha256 ||
            proof.operationId === occurrence.operationId) denied();
    }
}

const CASE_FIELDS = ['schemaVersion', 'caseId', 'scope', 'revision', 'status', 'createdAt', 'updatedAt',
    'initiatorSubjectKey', 'acceptBefore', 'templateRef', 'templateSha256', 'template', 'authorityRef',
    'candidateProof', 'approval', 'acceptanceReceipt', 'revocationEffect', 'decisions', 'headSha256'];
const CASE_ACTIONS = ['create', 'bind_identity', 'approve', 'accept', 'revoke', 'expire', 'deny'];
function commandValue(command) {
    record(command, ['action', 'operationId', 'expectedRevision', 'actorSubjectKey', 'at', 'payload']);
    if (!CASE_ACTIONS.includes(command.action)) fail(); uuid(command.operationId);
    if (command.expectedRevision !== null) revision(command.expectedRevision);
    subject(command.actorSubjectKey); instant(command.at); return command;
}
function commandIntent(command) {
    const { at, ...intent } = command; return intent;
}
function appendCase(state, command, changes) {
    const nextRevision = state ? state.revision + 1 : 0;
    revision(nextRevision);
    const base = { schemaVersion: 1, revision: nextRevision, parentSha256: state ? state.headSha256 : null, command };
    const decision = { ...base, sha256: canonicalDigest(base) };
    const next = { ...state, ...changes, revision: nextRevision, updatedAt: command.at,
        decisions: state ? state.decisions.concat(decision) : [decision], headSha256: decision.sha256 };
    if (command.action === 'approve') next.approval = { approvalId: command.payload.approvalId,
        revision: nextRevision, sha256: decision.sha256, acceptBefore: command.payload.acceptBefore,
        authorityRef: command.payload.authorityRef, candidateProofId: state.candidateProof.proofId,
        candidateProofSha256: state.candidateProof.proofSha256, identitySha256: state.candidateProof.identitySha256 };
    return freeze(detach(next, EFFECT_BYTES));
}
function createCaseCommand(command) {
    commandValue(command); if (command.action !== 'create' || command.expectedRevision !== null) fail();
    const value = record(command.payload, ['caseId', 'templateRef', 'template', 'acceptBefore', 'authorityRef']);
    uuid(value.caseId); identifier(value.templateRef); templateValue(value.template); authorityRef(value.authorityRef);
    if (instant(value.acceptBefore) <= command.at) fail();
    return appendCase(null, command, { schemaVersion: 1, caseId: value.caseId, scope: value.template.scope,
        status: 'awaiting_identity', createdAt: command.at, initiatorSubjectKey: command.actorSubjectKey,
        acceptBefore: value.acceptBefore, templateRef: value.templateRef, templateSha256: canonicalDigest(value.template),
        template: value.template, authorityRef: value.authorityRef, candidateProof: null, approval: null,
        acceptanceReceipt: null, revocationEffect: null });
}
function createOnboardingCase(value) {
    return input(() => {
        const facts = record(detach(value), ['caseId', 'templateRef', 'template', 'acceptBefore',
            'initiatorSubjectKey', 'authorityRef', 'operationId', 'createdAt']);
        const { initiatorSubjectKey, operationId, createdAt, ...payload } = facts;
        return createCaseCommand({ action: 'create', operationId, expectedRevision: null,
            actorSubjectKey: initiatorSubjectKey, at: createdAt, payload });
    });
}
function effectiveDeadline(state) {
    return state.approval && state.approval.acceptBefore < state.acceptBefore ? state.approval.acceptBefore : state.acceptBefore;
}
function applyCase(state, command) {
    commandValue(command);
    const prior = state.decisions.find(row => row.command.operationId === command.operationId);
    if (prior) { if (!same(commandIntent(prior.command), commandIntent(command))) conflict(); return state; }
    if (command.expectedRevision !== state.revision || command.at < state.updatedAt ||
        state.revision === Number.MAX_SAFE_INTEGER) conflict();
    if (['revoked', 'expired', 'denied'].includes(state.status) || command.action === 'create') conflict();
    let changes;
    switch (command.action) {
    case 'bind_identity': {
        record(command.payload, ['proof']);
        if (state.status !== 'awaiting_identity') conflict();
        const proof = retained(() => proofValue(command.payload.proof)); currentProof(proof, state, command.at, true);
        if (command.at >= state.acceptBefore || command.actorSubjectKey !== proof.subjectKey) denied();
        changes = { status: 'identity_verified', candidateProof: proof }; break;
    }
    case 'approve': {
        const value = record(command.payload, ['approvalId', 'acceptBefore', 'authorityRef']);
        uuid(value.approvalId); instant(value.acceptBefore); nextAuthority(value.authorityRef, state.authorityRef);
        if (state.status !== 'identity_verified') conflict();
        if (value.acceptBefore > state.acceptBefore || command.at >= value.acceptBefore) denied();
        changes = { status: 'approved' }; break;
    }
    case 'accept': {
        record(command.payload, ['receipt']); if (state.status !== 'approved') conflict();
        const receipt = retained(() => receiptValue(command.payload.receipt));
        if (!same(receipt.originalFacts.caseState, state) || receipt.operationId !== command.operationId ||
            receipt.effect.acceptedAt !== command.at || command.actorSubjectKey !== state.candidateProof.subjectKey) denied();
        changes = { status: 'accepted', acceptanceReceipt: receipt }; break;
    }
    case 'expire':
        record(command.payload, []);
        if (state.status === 'accepted') conflict();
        if (command.at < effectiveDeadline(state)) denied();
        changes = { status: 'expired' }; break;
    case 'deny':
        record(command.payload, ['authorityRef']); nextAuthority(command.payload.authorityRef,
            state.approval ? state.approval.authorityRef : state.authorityRef);
        if (state.status === 'accepted') conflict();
        changes = { status: 'denied' }; break;
    case 'revoke': {
        record(command.payload, ['authorityRef', 'predecessor']); nextAuthority(command.payload.authorityRef,
            state.approval ? state.approval.authorityRef : state.authorityRef);
        let revocationEffect = null;
        if (state.status === 'accepted') {
            const predecessor = retained(() => strictAuthority(command.payload.predecessor, state.scope));
            inclusion(state.acceptanceReceipt, predecessor);
            let membershipState = predecessor.membershipState;
            const member = membershipState.memberships.find(row => row.membershipId === state.template.membership.membershipId);
            if (command.at < membershipState.updatedAt) conflict();
            if (member.status !== 'removed') {
                if (membershipState.revision === Number.MAX_SAFE_INTEGER) conflict();
                membershipState = applyMembershipCommand(membershipState, predecessor.tenantAggregate, { ...state.scope,
                    expectedRevision: membershipState.revision, actorSubjectKey: command.actorSubjectKey, now: command.at,
                    action: 'remove', payload: { membershipId: member.membershipId } });
            }
            revocationEffect = { schemaVersion: 1, bindingId: state.template.bindingId,
                predecessor, nextMembershipState: membershipState, revokedAt: command.at };
        } else if (command.payload.predecessor !== null) fail();
        changes = { status: 'revoked', revocationEffect }; break;
    }
    default: fail();
    }
    return appendCase(state, command, changes);
}
function caseValue(value) {
    record(value, CASE_FIELDS); schema(value.schemaVersion);
    if (!Array.isArray(value.decisions) || !value.decisions.length || value.decisions.length > 5) fail();
    let state;
    for (let index = 0; index < value.decisions.length; index += 1) {
        const row = record(value.decisions[index], ['schemaVersion', 'revision', 'parentSha256', 'command', 'sha256']);
        schema(row.schemaVersion); revision(row.revision); digest(row.sha256);
        if (row.revision !== index || row.parentSha256 !== (state ? state.headSha256 : null)) fail();
        state = state ? applyCase(state, row.command) : createCaseCommand(row.command);
        if (!same(row, state.decisions[index])) fail();
    }
    if (!same(value, state)) fail(); return state;
}
function normaliseOnboardingState(value) { return retained(() => caseValue(detach(value, EFFECT_BYTES))); }
function applyOnboardingCommand(state, command) {
    const current = normaliseOnboardingState(state);
    return input(() => applyCase(current, detach(command)));
}

function acceptanceIntent(state, operationId) {
    uuid(operationId); if (state.status !== 'approved') conflict();
    return freeze({ schemaVersion: 1, operationType: 'accept', operationId, caseId: state.caseId, scope: state.scope,
        caseRevision: state.revision, caseSha256: state.headSha256, templateRef: state.templateRef,
        templateSha256: state.templateSha256, identity: state.candidateProof.identity,
        identitySha256: state.candidateProof.identitySha256, originalProofId: state.candidateProof.proofId,
        originalProofSha256: state.candidateProof.proofSha256, approval: state.approval,
        initiatorSubjectKey: state.initiatorSubjectKey, bindingId: state.template.bindingId,
        invitationExpiresAt: [state.acceptBefore, state.approval.acceptBefore, state.template.membership.validUntil].sort()[0] });
}
function createAcceptanceIntent(value) {
    return input(() => {
        value = candidateEnvelope(value, ['caseState', 'operationId'], ['caseState']);
        return acceptanceIntent(retained(() => caseValue(value.caseState)), value.operationId);
    });
}
function receiptFromFacts(value) {
    record(value, ['receiptId', 'caseState', 'proof', 'operationId', 'acceptedAt', 'predecessor']);
    uuid(value.receiptId); uuid(value.operationId); instant(value.acceptedAt);
    const state = retained(() => caseValue(value.caseState)), proof = retained(() => proofValue(value.proof));
    const intent = acceptanceIntent(state, value.operationId);
    if (value.acceptedAt < state.updatedAt) denied(); currentProof(proof, state, value.acceptedAt);
    const effect = effectFromFacts(detach({ template: state.template, identity: state.candidateProof.identity,
        initiatorSubjectKey: state.initiatorSubjectKey, caseAcceptBefore: state.acceptBefore,
        approvalAcceptBefore: state.approval.acceptBefore, acceptedAt: value.acceptedAt, predecessor: value.predecessor }));
    const receipt = { schemaVersion: 1, receiptId: value.receiptId, operationId: value.operationId,
        caseId: state.caseId, scope: state.scope, intent, intentSha256: canonicalDigest(intent),
        originalFacts: { caseState: state, proof, predecessor: value.predecessor }, effect, effectSha256: canonicalDigest(effect) };
    return freeze(detach({ ...receipt, receiptSha256: canonicalDigest(receipt) }, EFFECT_BYTES));
}
function createAcceptanceReceipt(value) {
    return input(() => receiptFromFacts(candidateEnvelope(value, ['receiptId', 'caseState', 'proof', 'operationId',
        'acceptedAt', 'predecessor'], ['caseState', 'proof', 'predecessor'])));
}
function receiptValue(value) {
    record(value, ['schemaVersion', 'receiptId', 'operationId', 'caseId', 'scope', 'intent', 'intentSha256',
        'originalFacts', 'effect', 'effectSha256', 'receiptSha256']); schema(value.schemaVersion);
    record(value.originalFacts, ['caseState', 'proof', 'predecessor']);
    const expected = receiptFromFacts({ ...value.originalFacts, receiptId: value.receiptId,
        operationId: value.operationId, acceptedAt: value.effect.acceptedAt });
    if (!same(expected, value)) fail(); return expected;
}
function normaliseAcceptanceReceipt(value) { return retained(() => receiptValue(detach(value, EFFECT_BYTES))); }

function committedAuthority(receipt) {
    return receipt.effect.kind === 'bootstrap' ? receipt.effect.initialState :
        { ...receipt.effect.predecessor, membershipState: receipt.effect.nextMembershipState };
}
function dominates(current, original) {
    if (current.revision < original.revision || current.revision === original.revision && !same(current, original)) fail();
}
function ownerIncluded(current, original) {
    dominates(current, original);
    const immutable = row => ({ ...row, recordStatus: null, revision: null });
    if (!same(immutable(current), immutable(original))) fail();
    if (original.recordStatus === 'closed') {
        if (!same(current, original)) fail();
    } else if (current.recordStatus !== 'closed') {
        // Every surviving active/suspended transition flips status once.
        const even = (current.revision - original.revision) % 2 === 0;
        if ((current.recordStatus === original.recordStatus) !== even) fail();
    }
}
function retainedMember(current, original) {
    const immutable = ['tenantId', 'organisationId', 'membershipId', 'invitationId', 'subjectKey', 'roles',
        'validFrom', 'validUntil', 'grantEvidenceId', 'createdAt', 'createdBy'];
    if (!current || immutable.some(key => !same(current[key], original[key])) || current.updatedAt < original.updatedAt ||
        original.status === 'removed' && !same(current, original)) fail();
}
function inclusion(receipt, current) {
    strictAuthority(current, receipt.scope);
    const original = committedAuthority(receipt);
    // Both complete aggregates have already passed strict canonical validation;
    // this only normalizes comparison values and never fills a missing field or
    // rewrites the receipt's retained predecessor.
    const originalOwners = createTenantAggregate(original.tenantAggregate);
    const currentOwners = createTenantAggregate(current.tenantAggregate);
    ownerIncluded(currentOwners.tenant, originalOwners.tenant);
    for (const organisation of originalOwners.organisations) {
        const retainedOrg = currentOwners.organisations.find(row => row.organisationId === organisation.organisationId);
        if (!retainedOrg) fail(); ownerIncluded(retainedOrg, organisation);
    }
    dominates(current.membershipState, original.membershipState);
    if (current.membershipState.updatedAt < original.membershipState.updatedAt) fail();
    for (const member of original.membershipState.memberships) {
        retainedMember(current.membershipState.memberships.find(row => row.membershipId === member.membershipId), member);
    }
    for (const invitation of original.membershipState.invitations) {
        const retainedInvite = current.membershipState.invitations.find(row => row.invitationId === invitation.invitationId);
        if (!retainedInvite || ['tenantId', 'organisationId', 'invitationId', 'subjectKey', 'roles', 'validFrom',
            'validUntil', 'grantEvidenceId', 'createdAt', 'createdBy', 'expiresAt'].some(key => !same(retainedInvite[key], invitation[key]))) fail();
        if (['accepted', 'revoked', 'expired'].includes(invitation.status) && !same(retainedInvite, invitation)) fail();
        if (retainedInvite.updatedAt < invitation.updatedAt) fail();
    }
    dominates(current.entitlementState, original.entitlementState); dominates(current.flags, original.flags);
    const originalGrants = normaliseEntitlementState(original.entitlementState, original.tenantAggregate).grants;
    const currentGrants = normaliseEntitlementState(current.entitlementState, current.tenantAggregate).grants;
    for (const grant of originalGrants) {
        const replacement = currentGrants.find(row => row.grantId === grant.grantId);
        if (!replacement || !same({ ...grant, status: null }, { ...replacement, status: null }) ||
            grant.status === 'revoked' && replacement.status !== 'revoked') fail();
    }
    for (const assignment of original.advisorAssignments) {
        const retainedAssignment = current.advisorAssignments.find(row => row.assignmentId === assignment.assignmentId);
        if (!retainedAssignment) fail(); dominates(retainedAssignment, assignment);
        const immutable = row => ({ ...normaliseAdvisorAssignment(row), status: null, updatedAt: null, revision: null });
        if (!same(immutable(assignment), immutable(retainedAssignment)) || retainedAssignment.updatedAt < assignment.updatedAt ||
            assignment.status === 'revoked' && retainedAssignment.status !== 'revoked') fail();
    }
    return receipt;
}
function assertAcceptanceIncluded(receipt, currentAuthority) {
    return retained(() => inclusion(receiptValue(detach(receipt, EFFECT_BYTES)), detach(currentAuthority, EFFECT_BYTES)));
}
function reconcileAcceptanceReceipt(value) {
    const facts = input(() => record(detach(value), ['receipt', 'caseState', 'proof', 'currentAuthority', 'currentBinding', 'at']));
    const receipt = normaliseAcceptanceReceipt(facts.receipt), state = normaliseOnboardingState(facts.caseState);
    const proof = normaliseIdentityProof(facts.proof);
    assertAcceptanceIncluded(receipt, facts.currentAuthority);
    retained(() => bindingIncluded(createStagedIdentityBinding(receipt), facts.currentBinding));
    return input(() => {
        instant(facts.at);
        if (state.status !== 'accepted' || !same(state.acceptanceReceipt, receipt) || facts.at < state.updatedAt ||
            facts.currentBinding.status !== 'active' || facts.at < facts.currentBinding.updatedAt ||
            facts.at < facts.currentBinding.validFrom || facts.at >= facts.currentBinding.validUntil) denied();
        currentProof(proof, state, facts.at);
        const authority = facts.currentAuthority;
        let member;
        try { member = resolveActiveMembership(authority.membershipState, authority.tenantAggregate,
            { ...receipt.scope, subjectKey: proof.subjectKey }, facts.at); } catch (_) { denied(); }
        if (member.membershipId !== state.template.membership.membershipId) denied();
        return receipt;
    });
}

const BINDING_FIELDS = ['schemaVersion', 'bindingId', 'scope', 'membershipId', 'invitationId', 'grantEvidenceId',
    'identity', 'identitySha256', 'subjectKey', 'origin', 'caseId', 'approvalId', 'approvalRevision', 'approvalSha256',
    'acceptanceReceiptId', 'publicationReceiptId', 'authorityRef', 'revision', 'status', 'validFrom', 'validUntil',
    'createdAt', 'updatedAt', 'organisationLabel'];
function bindingValue(value) {
    record(value, BINDING_FIELDS); schema(value.schemaVersion); uuid(value.bindingId); scope(value.scope);
    for (const key of ['membershipId', 'invitationId', 'grantEvidenceId']) identifier(value[key]);
    identityValue(value.identity); digest(value.identitySha256); subject(value.subjectKey);
    if (value.identitySha256 !== canonicalDigest(value.identity) || value.subjectKey !== subjectOf(value.identity)) fail();
    authorityRef(value.authorityRef); revision(value.revision);
    if (!['active', 'revoked'].includes(value.status) || instant(value.validFrom) >= instant(value.validUntil) ||
        instant(value.createdAt) > instant(value.updatedAt)) fail();
    if (value.status === 'active' ? value.revision !== 0 || value.updatedAt !== value.createdAt : value.revision !== 1) fail();
    if (typeof value.organisationLabel !== 'string' || !value.organisationLabel || value.organisationLabel.length > 200) fail();
    const staged = ['caseId', 'approvalId', 'approvalRevision', 'approvalSha256', 'acceptanceReceiptId'];
    if (value.origin === 'staged_acceptance') {
        if (value.publicationReceiptId !== null) fail();
        uuid(value.caseId); uuid(value.approvalId); revision(value.approvalRevision); digest(value.approvalSha256);
        uuid(value.acceptanceReceiptId);
    } else if (value.origin === 'existing_membership') {
        if (staged.some(key => value[key] !== null)) fail(); uuid(value.publicationReceiptId);
    } else fail();
    return value;
}
function normaliseIdentityBinding(value) { return retained(() => freeze(bindingValue(detach(value, SMALL_BYTES)))); }
function bindingFromMember(facts) {
    const { bindingId, identity, authorityRef: approval, member, target, at, organisationLabel } = facts;
    return { schemaVersion: 1, bindingId, scope: target, membershipId: member.membershipId,
        invitationId: member.invitationId, grantEvidenceId: member.grantEvidenceId, identity,
        identitySha256: canonicalDigest(identity), subjectKey: subjectOf(identity), authorityRef: approval,
        revision: 0, status: 'active', validFrom: member.validFrom, validUntil: member.validUntil,
        createdAt: at, updatedAt: at, organisationLabel };
}
function createStagedIdentityBinding(value) {
    const receipt = normaliseAcceptanceReceipt(value);
    return input(() => {
        const state = receipt.originalFacts.caseState, committed = committedAuthority(receipt);
        const member = committed.membershipState.memberships.find(row => row.membershipId === state.template.membership.membershipId);
        const organisation = resolveOrganisation(committed.tenantAggregate, receipt.scope);
        return freeze(detach(bindingValue({ ...bindingFromMember({ bindingId: receipt.effect.bindingId,
            identity: receipt.intent.identity, authorityRef: state.approval.authorityRef, member, target: receipt.scope,
            at: receipt.effect.acceptedAt, organisationLabel: organisation.displayName }), origin: 'staged_acceptance',
        caseId: state.caseId, approvalId: state.approval.approvalId, approvalRevision: state.approval.revision,
        approvalSha256: state.approval.sha256, acceptanceReceiptId: receipt.receiptId, publicationReceiptId: null }), SMALL_BYTES));
    });
}
const PUBLICATION_FIELDS = ['receiptId', 'operationId', 'scope', 'membershipId', 'invitationId', 'grantEvidenceId',
    'identity', 'bindingId', 'validFrom', 'validUntil', 'authorityRef', 'actorSubjectKey', 'at', 'currentAuthority'];
function publicationFromFacts(value) {
    record(value, PUBLICATION_FIELDS); uuid(value.receiptId); uuid(value.operationId); uuid(value.bindingId);
    scope(value.scope); identityValue(value.identity); authorityRef(value.authorityRef); subject(value.actorSubjectKey); instant(value.at);
    for (const key of ['membershipId', 'invitationId', 'grantEvidenceId']) identifier(value[key]);
    if (instant(value.validFrom) >= instant(value.validUntil)) fail();
    const authority = retained(() => strictAuthority(value.currentAuthority, value.scope));
    let member;
    try { member = resolveActiveMembership(authority.membershipState, authority.tenantAggregate,
        { ...value.scope, subjectKey: subjectOf(value.identity) }, value.at); } catch (_) { denied(); }
    if (['membershipId', 'invitationId', 'grantEvidenceId', 'validFrom', 'validUntil'].some(key => member[key] !== value[key])) denied();
    const organisation = resolveOrganisation(authority.tenantAggregate, value.scope);
    const binding = bindingValue({ ...bindingFromMember({ bindingId: value.bindingId, identity: value.identity,
        authorityRef: value.authorityRef, member, target: value.scope, at: value.at, organisationLabel: organisation.displayName }),
    origin: 'existing_membership', caseId: null, approvalId: null, approvalRevision: null, approvalSha256: null,
    acceptanceReceiptId: null, publicationReceiptId: value.receiptId });
    const { receiptId, actorSubjectKey, at, currentAuthority, ...business } = value;
    const intent = { schemaVersion: 1, operationType: 'publish_existing_membership', ...business, actorSubjectKey };
    const receipt = { schemaVersion: 1, operationType: 'publish_existing_membership', receiptId,
        operationId: value.operationId, intent, intentSha256: canonicalDigest(intent),
        originalFacts: { currentAuthority, actorSubjectKey, at }, binding, resultSha256: canonicalDigest(binding) };
    return freeze(detach({ ...receipt, receiptSha256: canonicalDigest(receipt) }, EFFECT_BYTES));
}
function publishExistingMembershipBinding(value) {
    return input(() => publicationFromFacts(candidateEnvelope(value, PUBLICATION_FIELDS, ['currentAuthority'])));
}
function publicationValue(value) {
    record(value, ['schemaVersion', 'operationType', 'receiptId', 'operationId', 'intent', 'intentSha256',
        'originalFacts', 'binding', 'resultSha256', 'receiptSha256']);
    schema(value.schemaVersion); if (value.operationType !== 'publish_existing_membership') fail();
    record(value.originalFacts, ['currentAuthority', 'actorSubjectKey', 'at']);
    const { schemaVersion, operationType, ...business } = value.intent;
    const expected = publicationFromFacts({ ...business, ...value.originalFacts, receiptId: value.receiptId });
    if (!same(expected, value)) fail(); return expected;
}
function normalisePublicationReceipt(value) { return retained(() => publicationValue(detach(value, EFFECT_BYTES))); }
function bindingIncluded(original, current) {
    bindingValue(current); dominates(current, original);
    if (BINDING_FIELDS.filter(key => !['revision', 'status', 'updatedAt'].includes(key))
        .some(key => !same(current[key], original[key])) || current.updatedAt < original.updatedAt) fail();
}
function reconcilePublicationReceipt(value) {
    const facts = input(() => record(detach(value), ['receipt', 'currentAuthority', 'currentBinding', 'at']));
    const receipt = normalisePublicationReceipt(facts.receipt);
    retained(() => {
        strictAuthority(facts.currentAuthority, receipt.binding.scope);
        bindingIncluded(receipt.binding, facts.currentBinding);
        const original = receipt.originalFacts.currentAuthority, current = facts.currentAuthority;
        dominates(current.membershipState, original.membershipState);
        const member = original.membershipState.memberships.find(row => row.membershipId === receipt.binding.membershipId);
        retainedMember(current.membershipState.memberships.find(row => row.membershipId === member.membershipId), member);
        const invitation = original.membershipState.invitations.find(row => row.invitationId === member.invitationId);
        if (!same(current.membershipState.invitations.find(row => row.invitationId === member.invitationId), invitation)) fail();
    });
    return input(() => {
        instant(facts.at); if (facts.currentBinding.status !== 'active' || facts.at < facts.currentBinding.updatedAt) denied();
        let member;
        try { member = resolveActiveMembership(facts.currentAuthority.membershipState, facts.currentAuthority.tenantAggregate,
            { ...receipt.binding.scope, subjectKey: receipt.binding.subjectKey }, facts.at); } catch (_) { denied(); }
        if (member.membershipId !== receipt.binding.membershipId) denied(); return receipt;
    });
}

function revokeIdentityBinding(value) {
    return input(() => {
        const facts = candidateEnvelope(value, ['predecessor', 'expectedRevision', 'authorityRef', 'at'], ['predecessor']);
        const previous = retained(() => bindingValue(facts.predecessor)); revision(facts.expectedRevision); instant(facts.at);
        nextAuthority(facts.authorityRef, previous.authorityRef);
        if (previous.revision !== facts.expectedRevision || previous.revision === Number.MAX_SAFE_INTEGER ||
            previous.status !== 'active' || facts.at < previous.updatedAt) conflict();
        return freeze(detach({ ...previous, status: 'revoked', revision: previous.revision + 1, updatedAt: facts.at }, SMALL_BYTES));
    });
}

const SESSION_FIELDS = ['schemaVersion', 'sessionSha256', 'kind', 'parentSessionSha256',
    'operatorIssuanceSha256', 'identitySha256', 'identityPayload', 'subjectKey',
    'status', 'revision', 'selectionGeneration', 'generationToken', 'selectedBindingId',
    'selectedTenantId', 'selectedOrganisationId', 'discoveryCaseId', 'discoveryProofId',
    'issuedAt', 'expiresAt', 'restoreEpoch', 'instanceId', 'createdAt', 'updatedAt', 'revokedAt'];

function operatorIssuanceValue(value) {
    record(value, ['schemaVersion', 'kind', 'sessionSha256', 'identitySha256',
        'instanceId', 'restoreEpoch', 'issuedAt', 'expiresAt']);
    schema(value.schemaVersion);
    if (value.kind !== 'operator_dashboard_issuance') fail();
    digest(value.sessionSha256); digest(value.identitySha256);
    uuid(value.instanceId); uuid(value.restoreEpoch);
    if (instant(value.issuedAt) >= instant(value.expiresAt)) fail();
    return value;
}

function normaliseOperatorIssuanceProof(value) {
    return input(() => freeze(operatorIssuanceValue(detach(value, SMALL_BYTES))));
}

function sessionSeedValue(value) {
    record(value, ['identityPayload', 'instanceId', 'restoreEpoch', 'issuedAt', 'expiresAt']);
    identityValue(value.identityPayload); uuid(value.instanceId); uuid(value.restoreEpoch);
    if (instant(value.issuedAt) >= instant(value.expiresAt)) fail();
    return value;
}

function sessionSeedOf(value) {
    return { identityPayload: value.identityPayload, instanceId: value.instanceId,
        restoreEpoch: value.restoreEpoch, issuedAt: value.issuedAt, expiresAt: value.expiresAt };
}

function sessionValue(value) {
    record(value, SESSION_FIELDS); schema(value.schemaVersion);
    digest(value.sessionSha256); digest(value.identitySha256); digest(value.generationToken);
    identityValue(value.identityPayload); uuid(value.instanceId); uuid(value.restoreEpoch);
    revision(value.revision); revision(value.selectionGeneration);
    if (value.identitySha256 !== canonicalDigest(value.identityPayload) ||
        value.subjectKey !== subjectOf(value.identityPayload) ||
        value.revision !== value.selectionGeneration ||
        !['operator_dashboard', 'onboarding_discovery', 'customer'].includes(value.kind) ||
        !['active', 'revoked'].includes(value.status)) fail();
    if (instant(value.issuedAt) >= instant(value.expiresAt) ||
        instant(value.createdAt) < value.issuedAt || instant(value.updatedAt) < value.createdAt) fail();
    if (value.status === 'revoked') {
        if (instant(value.revokedAt) !== value.updatedAt) fail();
    } else if (value.revokedAt !== null || value.updatedAt >= value.expiresAt) fail();
    if (value.revision === 0 && value.createdAt !== value.updatedAt) fail();
    if (value.revision > 0 && value.createdAt >= value.expiresAt) fail();

    const selected = value.selectedBindingId !== null;
    if (selected) {
        uuid(value.selectedBindingId); identifier(value.selectedTenantId); identifier(value.selectedOrganisationId);
    } else if (value.selectedTenantId !== null || value.selectedOrganisationId !== null) fail();
    if (value.kind === 'onboarding_discovery') {
        uuid(value.discoveryCaseId); uuid(value.discoveryProofId);
        if (selected || value.revision !== (value.status === 'active' ? 0 : 1)) fail();
    } else if (value.discoveryCaseId !== null || value.discoveryProofId !== null) fail();

    if (value.kind === 'operator_dashboard') {
        if (value.parentSessionSha256 !== value.sessionSha256) fail();
        if (value.operatorIssuanceSha256 === null) {
            // The sole proofless record is an absent-gate logout tombstone.
            if (value.status !== 'revoked' || value.revision !== 0 || selected) fail();
        } else {
            digest(value.operatorIssuanceSha256);
            if (value.status === 'active' ? selected !== (value.revision > 0) :
                value.revision === 0 || selected !== (value.revision > 1)) fail();
        }
    } else {
        if (value.parentSessionSha256 !== null || value.operatorIssuanceSha256 !== null) fail();
        if (value.kind === 'customer' && (!selected || value.status === 'revoked' && value.revision === 0)) fail();
    }
    return value;
}

function normaliseSessionRecord(value) {
    return retained(() => freeze(sessionValue(detach(value, SMALL_BYTES))));
}

// Inspect just the outer descriptors first. Detaching the whole envelope before
// separating its retained predecessor would misclassify corruption as new input.
function sessionEnvelopeValues(value) {
    return envelopeValues(value, ['predecessor', 'command', 'facts']);
}

function sessionFactsValue(command, value) {
    const field = command.operationType === 'initializeOperatorSession' ? 'operatorIssuanceProof' :
        ['activateCustomerSession', 'selectBinding'].includes(command.operationType) ? 'binding' :
        command.operationType === 'recordProofAndActivateDiscovery' ? 'proof' : null;
    const fields = ['occurredAt', 'generationToken'].concat(field ? [field] : []);
    const supplied = envelopeValues(value, fields);
    if (field) supplied[field] = retained(() => {
        const stored = detach(supplied[field], SMALL_BYTES);
        if (field === 'binding') return bindingValue(stored);
        if (field === 'proof') return proofValue(stored);
        return operatorIssuanceValue(stored);
    });
    return detach(supplied, SMALL_BYTES);
}

function sessionCommandAndFacts(command, facts) {
    record(command, ['schemaVersion', 'operationType', 'operationId', 'sessionSha256', 'actorSubjectKey', 'payload']);
    schema(command.schemaVersion); uuid(command.operationId); digest(command.sessionSha256);
    subject(command.actorSubjectKey);
    if (!SESSION_OPERATIONS.includes(command.operationType)) fail();
    const payload = command.payload;
    switch (command.operationType) {
        case 'initializeOperatorSession':
            record(payload, ['seed', 'operatorIssuanceSha256']);
            sessionSeedValue(payload.seed); digest(payload.operatorIssuanceSha256);
            record(facts, ['occurredAt', 'generationToken', 'operatorIssuanceProof']);
            retained(() => operatorIssuanceValue(facts.operatorIssuanceProof));
            break;
        case 'activateCustomerSession':
            record(payload, ['seed', 'bindingId']); sessionSeedValue(payload.seed); uuid(payload.bindingId);
            record(facts, ['occurredAt', 'generationToken', 'binding']); retained(() => bindingValue(facts.binding));
            break;
        case 'recordProofAndActivateDiscovery':
            record(payload, ['seed', 'caseId', 'proofId']); sessionSeedValue(payload.seed);
            uuid(payload.caseId); uuid(payload.proofId);
            record(facts, ['occurredAt', 'generationToken', 'proof']); retained(() => proofValue(facts.proof));
            break;
        case 'selectBinding':
            record(payload, ['bindingId', 'expectedRevision', 'expectedSelectionGeneration', 'expectedGeneration']);
            uuid(payload.bindingId); revision(payload.expectedRevision); revision(payload.expectedSelectionGeneration);
            digest(payload.expectedGeneration);
            record(facts, ['occurredAt', 'generationToken', 'binding']); retained(() => bindingValue(facts.binding));
            break;
        case 'revokeSession':
            record(payload, ['seed']); sessionSeedValue(payload.seed);
            record(facts, ['occurredAt', 'generationToken']);
            break;
        default: fail();
    }
    instant(facts.occurredAt); digest(facts.generationToken);
}

function sessionAt(seed, at, active) {
    if (at < seed.issuedAt || active && at >= seed.expiresAt) denied();
}

function sessionBinding(binding, bindingId, identity, at) {
    if (binding.bindingId !== bindingId || !same(binding.identity, identity) ||
        binding.status !== 'active' || binding.validFrom > at || binding.validUntil <= at ||
        binding.updatedAt > at) denied();
}

function sessionInitial(command, facts, kind, status) {
    const seed = command.payload.seed;
    return { schemaVersion: 1, sessionSha256: command.sessionSha256, kind,
        parentSessionSha256: kind === 'operator_dashboard' ? command.sessionSha256 : null,
        operatorIssuanceSha256: null, identitySha256: canonicalDigest(seed.identityPayload),
        identityPayload: seed.identityPayload, subjectKey: subjectOf(seed.identityPayload),
        status, revision: 0, selectionGeneration: 0, generationToken: facts.generationToken,
        selectedBindingId: null, selectedTenantId: null, selectedOrganisationId: null,
        discoveryCaseId: null, discoveryProofId: null, issuedAt: seed.issuedAt, expiresAt: seed.expiresAt,
        restoreEpoch: seed.restoreEpoch, instanceId: seed.instanceId,
        createdAt: facts.occurredAt, updatedAt: facts.occurredAt,
        revokedAt: status === 'revoked' ? facts.occurredAt : null };
}

function sessionSelected(value, binding) {
    return { ...value, selectedBindingId: binding.bindingId,
        selectedTenantId: binding.scope.tenantId, selectedOrganisationId: binding.scope.organisationId };
}

function sessionAdvanced(predecessor, facts) {
    if (predecessor.revision === Number.MAX_SAFE_INTEGER ||
        predecessor.selectionGeneration === Number.MAX_SAFE_INTEGER) conflict();
    if (facts.generationToken === predecessor.generationToken) conflict();
    return { ...predecessor, revision: predecessor.revision + 1,
        selectionGeneration: predecessor.selectionGeneration + 1,
        generationToken: facts.generationToken, updatedAt: facts.occurredAt };
}

function sessionTransition(predecessor, command, facts) {
    const payload = command.payload, at = facts.occurredAt;
    if (predecessor) {
        if (predecessor.sessionSha256 !== command.sessionSha256 ||
            predecessor.subjectKey !== command.actorSubjectKey) denied();
        if (at < predecessor.updatedAt) conflict();
    }
    if (command.operationType !== 'selectBinding') {
        if (subjectOf(payload.seed.identityPayload) !== command.actorSubjectKey) denied();
        if (predecessor && !same(payload.seed, sessionSeedOf(predecessor))) denied();
    }
    if (predecessor && predecessor.status === 'revoked' && command.operationType !== 'revokeSession') denied();

    switch (command.operationType) {
        case 'initializeOperatorSession': {
            const proof = facts.operatorIssuanceProof, seed = payload.seed;
            if (payload.operatorIssuanceSha256 !== canonicalDigest(proof) ||
                proof.sessionSha256 !== command.sessionSha256 ||
                proof.identitySha256 !== canonicalDigest(seed.identityPayload) ||
                proof.instanceId !== seed.instanceId || proof.restoreEpoch !== seed.restoreEpoch ||
                proof.issuedAt !== seed.issuedAt || proof.expiresAt !== seed.expiresAt) denied();
            sessionAt(seed, at, true);
            if (predecessor) {
                if (predecessor.kind !== 'operator_dashboard' ||
                    predecessor.operatorIssuanceSha256 !== payload.operatorIssuanceSha256) denied();
                return { record: predecessor, outcome: 'preserved' };
            }
            return { record: { ...sessionInitial(command, facts, 'operator_dashboard', 'active'),
                operatorIssuanceSha256: payload.operatorIssuanceSha256 }, outcome: 'initialized' };
        }
        case 'activateCustomerSession':
            if (predecessor) conflict();
            sessionAt(payload.seed, at, true);
            sessionBinding(facts.binding, payload.bindingId, payload.seed.identityPayload, at);
            return { record: sessionSelected(sessionInitial(command, facts, 'customer', 'active'), facts.binding),
                outcome: 'activated' };
        case 'recordProofAndActivateDiscovery': {
            if (predecessor) conflict();
            sessionAt(payload.seed, at, true);
            const proof = facts.proof;
            if (proof.caseId !== payload.caseId || proof.proofId !== payload.proofId ||
                !same(proof.identity, payload.seed.identityPayload) || proof.verifiedAt > payload.seed.issuedAt ||
                proof.freshUntil <= at || payload.seed.expiresAt > proof.freshUntil) denied();
            return { record: { ...sessionInitial(command, facts, 'onboarding_discovery', 'active'),
                discoveryCaseId: payload.caseId, discoveryProofId: payload.proofId }, outcome: 'activated' };
        }
        case 'selectBinding':
            if (!predecessor || predecessor.kind === 'onboarding_discovery') denied();
            sessionAt(predecessor, at, true);
            if (predecessor.revision !== payload.expectedRevision ||
                predecessor.selectionGeneration !== payload.expectedSelectionGeneration ||
                predecessor.generationToken !== payload.expectedGeneration) conflict();
            sessionBinding(facts.binding, payload.bindingId, predecessor.identityPayload, at);
            return { record: sessionSelected(sessionAdvanced(predecessor, facts), facts.binding), outcome: 'selected' };
        case 'revokeSession':
            sessionAt(payload.seed, at, false);
            if (!predecessor) {
                return { record: sessionInitial(command, facts, 'operator_dashboard', 'revoked'), outcome: 'tombstoned' };
            }
            if (predecessor.status === 'revoked') return { record: predecessor, outcome: 'preserved' };
            return { record: { ...sessionAdvanced(predecessor, facts), status: 'revoked', revokedAt: at }, outcome: 'revoked' };
        default: fail();
    }
}

function applySessionCommand(value) {
    const supplied = input(() => sessionEnvelopeValues(value));
    const predecessor = supplied.predecessor === null ? null : normaliseSessionRecord(supplied.predecessor);
    return input(() => {
        const command = detach(supplied.command, SMALL_BYTES), facts = sessionFactsValue(command, supplied.facts);
        detach({ predecessor, command, facts }, OPERATION_BYTES);
        sessionCommandAndFacts(command, facts);
        const result = sessionTransition(predecessor, command, facts);
        return freeze({ record: sessionValue(detach(result.record, SMALL_BYTES)), outcome: result.outcome });
    });
}


const EVIDENCE_KINDS = Object.freeze(['RG002', 'RG010', 'approval', 'effect']);
function admissionPayload(value) {
    record(value, ['schemaVersion', 'decision', 'target', 'identityPolicyRef', 'approvedEffectSha256',
        'evidenceRefs', 'validFrom', 'validUntil', 'actorSubjectKey', 'occurredAt']);
    schema(value.schemaVersion); scope(value.target); digest(value.approvedEffectSha256);
    record(value.identityPolicyRef, ['policyId', 'policyRevision']); identifier(value.identityPolicyRef.policyId);
    revision(value.identityPolicyRef.policyRevision); subject(value.actorSubjectKey); instant(value.occurredAt);
    if (!['eligible', 'withdrawn'].includes(value.decision) || instant(value.validFrom) >= instant(value.validUntil) ||
        !Array.isArray(value.evidenceRefs) || value.evidenceRefs.length > 16) fail();
    const seen = new Set();
    for (const evidence of value.evidenceRefs) {
        record(evidence, ['kind', 'id', 'sha256']);
        if (!EVIDENCE_KINDS.includes(evidence.kind)) fail(); identifier(evidence.id); digest(evidence.sha256);
        const key = evidence.kind + ':' + evidence.id; if (seen.has(key)) fail(); seen.add(key);
    }
    value.evidenceRefs.sort((a, b) => a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    return value;
}
function admissionValue(value) {
    record(value, ['schemaVersion', 'authorityId', 'scope', 'revision', 'parentRevision', 'parentSha256',
        'decisionSha256', 'payload']);
    schema(value.schemaVersion); uuid(value.authorityId); scope(value.scope); revision(value.revision);
    if (value.revision === 0) {
        if (value.parentRevision !== null || value.parentSha256 !== null || value.payload.decision !== 'eligible') fail();
    } else if (revision(value.parentRevision) !== value.revision - 1) fail();
    else digest(value.parentSha256);
    const payload = admissionPayload(value.payload); if (!same(payload.target, value.scope)) fail();
    digest(value.decisionSha256);
    const { decisionSha256, ...base } = value;
    if (canonicalDigest(base) !== decisionSha256) fail(); return value;
}
function normaliseAdmissionRecord(value) { return retained(() => freeze(admissionValue(detach(value, SMALL_BYTES)))); }
function admissionFromFacts(value) {
    record(value, ['predecessor', 'command', 'facts']);
    const command = record(value.command, ['schemaVersion', 'operationType', 'operationId', 'actorSubjectKey',
        'authorityId', 'expectedRevision', 'expectedHeadSha256', 'payload']);
    schema(command.schemaVersion); uuid(command.operationId); uuid(command.authorityId); subject(command.actorSubjectKey);
    if (!['publishAdmissionDecision', 'withdrawAdmissionDecision'].includes(command.operationType)) fail();
    record(value.facts, ['occurredAt']); instant(value.facts.occurredAt);
    const payload = record(command.payload, ['target', 'identityPolicyRef', 'approvedEffectSha256', 'evidenceRefs', 'validFrom', 'validUntil']);
    const nextPayload = admissionPayload({ schemaVersion: 1,
        decision: command.operationType === 'publishAdmissionDecision' ? 'eligible' : 'withdrawn',
        ...payload, actorSubjectKey: command.actorSubjectKey, occurredAt: value.facts.occurredAt });
    const previous = value.predecessor === null ? null : retained(() => admissionValue(value.predecessor));
    if (previous) {
        revision(command.expectedRevision); digest(command.expectedHeadSha256);
        if (previous.authorityId !== command.authorityId || !same(previous.scope, nextPayload.target) ||
            previous.revision !== command.expectedRevision || previous.decisionSha256 !== command.expectedHeadSha256 ||
            previous.revision === Number.MAX_SAFE_INTEGER || previous.payload.occurredAt > value.facts.occurredAt) conflict();
    } else if (command.expectedRevision !== null || command.expectedHeadSha256 !== null || nextPayload.decision !== 'eligible') conflict();
    const base = { schemaVersion: 1, authorityId: command.authorityId, scope: nextPayload.target,
        revision: previous ? previous.revision + 1 : 0, parentRevision: previous ? previous.revision : null,
        parentSha256: previous ? previous.decisionSha256 : null, payload: nextPayload };
    return freeze({ record: detach({ ...base, decisionSha256: canonicalDigest(base) }, SMALL_BYTES),
        outcome: nextPayload.decision === 'eligible' ? 'published' : 'withdrawn' });
}
function applyAdmissionCommand(value) {
    return input(() => admissionFromFacts(candidateEnvelope(value, ['predecessor', 'command', 'facts'], ['predecessor'])));
}

const ADMISSION_OPERATIONS = ['publishAdmissionDecision', 'withdrawAdmissionDecision'];
const SESSION_OPERATIONS = ['initializeOperatorSession', 'activateCustomerSession', 'recordProofAndActivateDiscovery', 'selectBinding', 'revokeSession'];
function transitionResult(value) {
    if (ADMISSION_OPERATIONS.includes(value.command.operationType)) return admissionFromFacts(value);
    if (SESSION_OPERATIONS.includes(value.command.operationType)) return applySessionCommand(value);
    fail();
}
function transitionReceiptFromFacts(value) {
    record(value, ['receiptId', 'auditEventId', 'predecessor', 'command', 'facts']);
    uuid(value.receiptId); uuid(value.auditEventId);
    const result = transitionResult({ predecessor: value.predecessor, command: value.command, facts: value.facts });
    const admission = ADMISSION_OPERATIONS.includes(value.command.operationType);
    const receipt = { schemaVersion: 1, receiptId: value.receiptId,
        anchorKind: admission ? 'authority' : 'session', anchorId: admission ? value.command.authorityId : value.command.sessionSha256,
        operationType: value.command.operationType, operationId: value.command.operationId,
        actorSubjectKey: value.command.actorSubjectKey, stableIntent: value.command, intentSha256: canonicalDigest(value.command),
        originalFacts: { predecessor: value.predecessor, facts: value.facts }, result,
        resultSha256: canonicalDigest(result), auditEventId: value.auditEventId };
    return freeze(detach({ ...receipt, receiptSha256: canonicalDigest(receipt) }, EFFECT_BYTES));
}
function createTransitionReceipt(value) {
    return input(() => {
        const fields = ['receiptId', 'auditEventId', 'predecessor', 'command', 'facts'];
        const supplied = envelopeValues(value, fields), command = detach(supplied.command, SMALL_BYTES);
        const facts = SESSION_OPERATIONS.includes(command.operationType) ? sessionFactsValue(command, supplied.facts) :
            detach(supplied.facts, SMALL_BYTES);
        return transitionReceiptFromFacts(candidateEnvelope({ ...supplied, command, facts }, fields, ['predecessor']));
    });
}
function transitionReceiptValue(value) {
    record(value, ['schemaVersion', 'receiptId', 'anchorKind', 'anchorId', 'operationType', 'operationId',
        'actorSubjectKey', 'stableIntent', 'intentSha256', 'originalFacts', 'result', 'resultSha256', 'auditEventId', 'receiptSha256']);
    record(value.originalFacts, ['predecessor', 'facts']);
    const expected = transitionReceiptFromFacts({ receiptId: value.receiptId, auditEventId: value.auditEventId,
        ...value.originalFacts, command: value.stableIntent });
    if (!same(value, expected)) fail(); return expected;
}
function normaliseTransitionReceipt(value) { return retained(() => transitionReceiptValue(detach(value, EFFECT_BYTES))); }
function transitionInclusion(value) {
    record(value, ['receipt', 'currentRecord', 'successorReceipts']);
    const receipt = transitionReceiptValue(value.receipt);
    if (!Array.isArray(value.successorReceipts) || value.successorReceipts.length > 256) fail();
    let current = receipt.result.record;
    const operations = new Set([receipt.operationId]), receipts = new Set([receipt.receiptId]), events = new Set([receipt.auditEventId]);
    for (const item of value.successorReceipts) {
        const next = transitionReceiptValue(item);
        if (next.anchorKind !== receipt.anchorKind || next.anchorId !== receipt.anchorId ||
            operations.has(next.operationId) || receipts.has(next.receiptId) || events.has(next.auditEventId) ||
            !same(next.originalFacts.predecessor, current)) fail();
        operations.add(next.operationId); receipts.add(next.receiptId); events.add(next.auditEventId); current = next.result.record;
    }
    if (!same(current, value.currentRecord)) fail(); return receipt;
}
function assertTransitionIncluded(value) { return retained(() => transitionInclusion(detach(value))); }
function replayTransitionReceipt(value) {
    const facts = input(() => record(detach(value), ['receipt', 'command', 'currentRecord', 'successorReceipts']));
    const receipt = normaliseTransitionReceipt(facts.receipt);
    if (!same(facts.command, receipt.stableIntent)) conflict();
    assertTransitionIncluded({ receipt, currentRecord: facts.currentRecord, successorReceipts: facts.successorReceipts });
    // Historical result only; never replace a later or revoked current record.
    return receipt.result;
}

module.exports = { DashboardOnboardingError, EFFECT_BYTES, OPERATION_BYTES, SMALL_BYTES,
    canonicalDigest, normaliseStableIdentity, normaliseTemplate, buildAcceptanceEffect, reconstructAcceptanceEffect,
    createIdentityProof, normaliseIdentityProof, createOnboardingCase, applyOnboardingCommand, normaliseOnboardingState,
    createAcceptanceIntent, createAcceptanceReceipt, normaliseAcceptanceReceipt, assertAcceptanceIncluded, reconcileAcceptanceReceipt,
    createStagedIdentityBinding, normaliseIdentityBinding, publishExistingMembershipBinding, normalisePublicationReceipt,
    reconcilePublicationReceipt, revokeIdentityBinding, EVIDENCE_KINDS,
    normaliseAdmissionRecord, applyAdmissionCommand, createTransitionReceipt, normaliseTransitionReceipt,
    assertTransitionIncluded, replayTransitionReceipt, normaliseOperatorIssuanceProof, normaliseSessionRecord, applySessionCommand };
