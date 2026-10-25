'use strict';

const crypto = require('node:crypto');
const { types } = require('node:util');
const { resolveOrganisation } = require('../appLifecycle/tenantDomain');

const SCHEMA_VERSION = 1;
const EVIDENCE_LIMITS = Object.freeze({
    commandBytes: 16384,
    stateBytes: 262144,
    ownershipBytes: 1048576,
    versions: 128,
    policyContentTypes: 32,
    legalHoldReferences: 16,
    ownershipOrganisations: 1024,
    ownershipDomainsPerOrganisation: 64
});
const SCOPE_FIELDS = ['tenantId', 'organisationId', 'artefactId'];
const DECLARATION_FIELDS = ['versionId', 'declaredContent', 'source',
    'classification', 'policySnapshot', 'governanceRefs'];
const SUBJECT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MIME = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,62}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,62}$/;
const CLASSIFICATIONS = ['Public', 'Internal', 'Confidential', 'Restricted'];
const TAGS = ['personal', 'high-risk-personal', 'credential-secret',
    'customer-confidential', 'security-sensitive', 'legal-hold'];
const SOURCE_KINDS = ['operator-declaration', 'system-derivation', 'provider-observation'];
const ERROR_STATUS = Object.freeze({
    shape_invalid: 400, collection_invalid: 400, identifier_invalid: 400,
    subject_invalid: 400, time_invalid: 400, revision_invalid: 400,
    digest_invalid: 400, content_invalid: 400, policy_invalid: 400,
    classification_invalid: 400, governance_invalid: 400,
    schema_unsupported: 400, history_invalid: 400, action_invalid: 400,
    payload_too_large: 400, not_found: 404, organisation_inactive: 409,
    revision_conflict: 409, time_regression: 409, version_duplicate: 409,
    policy_conflict: 409, governance_conflict: 409, capacity_reached: 409
});

class EvidenceDomainError extends Error {
    constructor(code) {
        const suffix = typeof code === 'string' && Object.hasOwn(ERROR_STATUS, code)
            ? code : 'shape_invalid';
        super(`evidence_${suffix}`);
        this.name = 'EvidenceDomainError';
        this.code = `evidence_${suffix}`;
        this.statusCode = ERROR_STATUS[suffix];
        // Domain failures contain no caller payload or implementation stack.
        delete this.stack;
        Object.freeze(this);
    }
}

function fail(code) { throw new EvidenceDomainError(code); }

// These are trusted-service facts, not credentials, policy approval or file safety.
function normaliseEvidenceSelector(input) {
    return freeze(record(input, SCOPE_FIELDS, new Set(), scopeOf));
}

function normaliseEvidenceCommand(input) {
    const stack = new Set();
    const command = record(input, [...SCOPE_FIELDS, 'action', 'expectedRevision',
        'actorSubjectKey', 'now', 'idempotencyKey', 'payload'], stack, row => {
        const scope = scopeOf(row);
        if (row.action !== 'create' && row.action !== 'append-version') fail('action_invalid');
        if (row.action === 'create') {
            if (row.expectedRevision !== null) fail('revision_invalid');
        } else revision(row.expectedRevision);
        const now = instant(row.now);
        return { ...scope, action: row.action, expectedRevision: row.expectedRevision,
            actorSubjectKey: subject(row.actorSubjectKey), now,
            idempotencyKey: identifier(row.idempotencyKey),
            payload: record(row.payload, DECLARATION_FIELDS, stack, payload =>
                declaration(payload, now, scope, stack, new Map())) };
    });
    assertBytes(command, EVIDENCE_LIMITS.commandBytes);
    return freeze(command);
}

function normaliseEvidenceState(input) {
    const stack = new Set();
    const state = record(input, ['schemaVersion', ...SCOPE_FIELDS, 'revision',
        'createdAt', 'createdBy', 'updatedAt', 'updatedBy', 'currentVersionId',
        'versions'], stack, row => {
        if (row.schemaVersion !== SCHEMA_VERSION) fail('schema_unsupported');
        const scope = scopeOf(row);
        const result = { schemaVersion: SCHEMA_VERSION, ...scope,
            revision: revision(row.revision), createdAt: instant(row.createdAt),
            createdBy: subject(row.createdBy), updatedAt: instant(row.updatedAt),
            updatedBy: subject(row.updatedBy), currentVersionId: identifier(row.currentVersionId) };
        const references = new Map();
        const policies = new Map();
        const versionIds = new Set();
        let previous = null;
        result.versions = collection(row.versions, 1, EVIDENCE_LIMITS.versions, stack,
            (inputVersion, index) => record(inputVersion, [...DECLARATION_FIELDS,
                'introducedRevision', 'previousVersionId', 'recordedAt', 'recordedBy',
                'quarantine'], stack, version => {
                const recordedAt = instant(version.recordedAt);
                const value = { ...declaration(version, recordedAt, scope, stack, references),
                    introducedRevision: revision(version.introducedRevision),
                    previousVersionId: version.previousVersionId === null
                        ? null : identifier(version.previousVersionId),
                    recordedAt, recordedBy: subject(version.recordedBy),
                    quarantine: record(version.quarantine, ['state', 'reason'], stack, quarantine => {
                        if (quarantine.state !== 'quarantined' || quarantine.reason !== 'content-unverified') {
                            fail('history_invalid');
                        }
                        return { state: 'quarantined', reason: 'content-unverified' };
                    }) };
                if (value.introducedRevision !== index ||
                    value.previousVersionId !== (previous ? previous.versionId : null) ||
                    (previous && value.recordedAt < previous.recordedAt) ||
                    versionIds.has(value.versionId)) fail('history_invalid');
                versionIds.add(value.versionId);
                assertPolicyIdentity(value.policySnapshot, policies);
                previous = value;
                return value;
            }));
        const first = result.versions[0];
        const last = result.versions[result.versions.length - 1];
        if (result.revision !== result.versions.length - 1 ||
            result.currentVersionId !== last.versionId ||
            result.createdAt !== first.recordedAt || result.createdBy !== first.recordedBy ||
            result.updatedAt !== last.recordedAt || result.updatedBy !== last.recordedBy) fail('history_invalid');
        return result;
    });
    assertBytes(state, EVIDENCE_LIMITS.stateBytes);
    return freeze(state);
}

function createEvidence(tenantAggregate, commandInput) {
    const command = normaliseEvidenceCommand(commandInput);
    if (command.action !== 'create') fail('action_invalid');
    assertActiveOwnership(tenantAggregate, command);
    return normaliseEvidenceState({ schemaVersion: SCHEMA_VERSION, ...scopeOf(command),
        revision: 0, createdAt: command.now, createdBy: command.actorSubjectKey,
        updatedAt: command.now, updatedBy: command.actorSubjectKey,
        currentVersionId: command.payload.versionId, versions: [newVersion(command, 0, null)] });
}

function applyEvidenceCommand(stateInput, tenantAggregate, commandInput) {
    const command = normaliseEvidenceCommand(commandInput);
    if (command.action !== 'append-version') fail('action_invalid');
    const state = normaliseEvidenceState(stateInput);
    if (SCOPE_FIELDS.some(field => state[field] !== command[field])) fail('not_found');
    assertActiveOwnership(tenantAggregate, command);
    if (command.expectedRevision !== state.revision) fail('revision_conflict');
    if (command.now < state.updatedAt) fail('time_regression');
    if (state.versions.length === EVIDENCE_LIMITS.versions) fail('capacity_reached');
    if (state.versions.some(version => version.versionId === command.payload.versionId)) fail('version_duplicate');
    // Re-normalizing checks retained policy and reference identities across the
    // complete history and the incoming declaration before any result is returned.
    return normaliseEvidenceState({ ...state, revision: state.revision + 1,
        updatedAt: command.now, updatedBy: command.actorSubjectKey,
        currentVersionId: command.payload.versionId,
        versions: [...state.versions, newVersion(command, state.revision + 1, state.currentVersionId)] });
}

function evidenceCommandFingerprint(commandInput) {
    const command = normaliseEvidenceCommand(commandInput);
    const intent = {};
    for (const key of Object.keys(command)) {
        if (key !== 'now' && key !== 'idempotencyKey') intent[key] = command[key];
    }
    return crypto.createHash('sha256').update('nofries:evidence-command:v1\n', 'utf8')
        .update(canonicalJson(intent), 'utf8').digest('hex');
}

function newVersion(command, introducedRevision, previousVersionId) {
    return { ...command.payload, introducedRevision, previousVersionId,
        recordedAt: command.now, recordedBy: command.actorSubjectKey,
        quarantine: { state: 'quarantined', reason: 'content-unverified' } };
}

function scopeOf(row) {
    return { tenantId: identifier(row.tenantId), organisationId: identifier(row.organisationId),
        artefactId: identifier(row.artefactId) };
}

function declaration(row, recordedAt, scope, stack, references) {
    const policySnapshot = policy(row.policySnapshot, stack);
    const declaredContent = record(row.declaredContent, ['sha256', 'contentType', 'sizeBytes'], stack, content => {
        const value = { sha256: digest(content.sha256), contentType: mime(content.contentType),
            sizeBytes: nonnegativeInteger(content.sizeBytes, 'content_invalid') };
        if (value.sizeBytes > policySnapshot.maximumDeclaredBytes ||
            !policySnapshot.allowedDeclaredContentTypes.includes(value.contentType)) fail('content_invalid');
        return value;
    });
    const source = record(row.source, ['kind', 'sourceId', 'sourceRevision',
        'observedAt', 'sourceMetadataSha256'], stack, value => {
        if (!SOURCE_KINDS.includes(value.kind)) fail('content_invalid');
        const observedAt = instant(value.observedAt);
        if (observedAt > recordedAt) fail('time_invalid');
        return { kind: value.kind, sourceId: identifier(value.sourceId),
            sourceRevision: identifier(value.sourceRevision), observedAt,
            sourceMetadataSha256: digest(value.sourceMetadataSha256) };
    });
    const classification = record(row.classification, ['level', 'tags'], stack, value => {
        if (!CLASSIFICATIONS.includes(value.level)) fail('classification_invalid');
        const tags = collection(value.tags, 0, TAGS.length, stack, tag => {
            if (!TAGS.includes(tag)) fail('classification_invalid');
            return tag;
        });
        if (new Set(tags).size !== tags.length ||
            ((tags.includes('high-risk-personal') || tags.includes('credential-secret')) &&
                value.level !== 'Restricted') ||
            (tags.includes('high-risk-personal') && !tags.includes('personal'))) fail('classification_invalid');
        return { level: value.level, tags: tags.sort() };
    });
    const governanceRefs = governance(row.governanceRefs, scope, stack, references);
    if (classification.tags.includes('legal-hold') !== (governanceRefs.legalHoldRefs.length > 0)) {
        fail('governance_invalid');
    }
    return { versionId: identifier(row.versionId), declaredContent, source,
        classification, policySnapshot, governanceRefs };
}

function policy(input, stack) {
    return record(input, ['policyId', 'policyVersion', 'maximumDeclaredBytes',
        'allowedDeclaredContentTypes'], stack, row => {
        const maximumDeclaredBytes = nonnegativeInteger(row.maximumDeclaredBytes, 'policy_invalid');
        if (maximumDeclaredBytes === 0) fail('policy_invalid');
        const allowedDeclaredContentTypes = collection(row.allowedDeclaredContentTypes, 1,
            EVIDENCE_LIMITS.policyContentTypes, stack, value => mime(value, 'policy_invalid'));
        if (new Set(allowedDeclaredContentTypes).size !== allowedDeclaredContentTypes.length) fail('policy_invalid');
        return { policyId: identifier(row.policyId), policyVersion: identifier(row.policyVersion),
            maximumDeclaredBytes, allowedDeclaredContentTypes: allowedDeclaredContentTypes.sort() };
    });
}

function assertPolicyIdentity(value, policies) {
    const key = canonicalJson([value.policyId, value.policyVersion]);
    const settings = canonicalJson(value);
    if (policies.has(key) && policies.get(key) !== settings) fail('policy_conflict');
    policies.set(key, settings);
}

function governance(input, scope, stack, references) {
    return record(input, ['purposeDecisionRef', 'metadataRetentionPolicyRef',
        'bytesRetentionPolicyRef', 'legalHoldRefs'], stack, row => {
        const reference = inputRef => record(inputRef, ['recordId', 'revision', 'recordSha256'], stack, value => {
            const ref = { recordId: identifier(value.recordId), revision: revision(value.revision),
                recordSha256: digest(value.recordSha256) };
            const key = canonicalJson([scope.tenantId, scope.organisationId, ref.recordId, ref.revision]);
            if (references.has(key) && references.get(key) !== ref.recordSha256) fail('governance_conflict');
            references.set(key, ref.recordSha256);
            return ref;
        });
        const purposeDecisionRef = reference(row.purposeDecisionRef);
        const metadataRetentionPolicyRef = reference(row.metadataRetentionPolicyRef);
        const bytesRetentionPolicyRef = reference(row.bytesRetentionPolicyRef);
        const legalHoldRefs = collection(row.legalHoldRefs, 0, EVIDENCE_LIMITS.legalHoldReferences, stack, reference);
        if (new Set(legalHoldRefs.map(ref => ref.recordId)).size !== legalHoldRefs.length) fail('governance_invalid');
        legalHoldRefs.sort((left, right) => compareStrings(left.recordId, right.recordId));
        return { purposeDecisionRef, metadataRetentionPolicyRef, bytesRetentionPolicyRef, legalHoldRefs };
    });
}

function assertActiveOwnership(input, selector) {
    let aggregate;
    try {
        const stack = new Set();
        aggregate = record(input, ['schemaVersion', 'tenant', 'organisations'], stack, row => {
            if (row.schemaVersion !== SCHEMA_VERSION) fail('shape_invalid');
            const tenant = record(row.tenant, ['schemaVersion', 'tenantId', 'displayName',
                'recordStatus', 'revision'], stack, ownershipRecord);
            const organisations = collection(row.organisations, 1, EVIDENCE_LIMITS.ownershipOrganisations,
                stack, inputOrganisation => record(inputOrganisation, ['schemaVersion', 'tenantId',
                    'organisationId', 'displayName', 'domains', 'recordStatus', 'revision'], stack, organisation => ({
                    ...ownershipRecord(organisation), organisationId: identifier(organisation.organisationId),
                    domains: collection(organisation.domains, 0, EVIDENCE_LIMITS.ownershipDomainsPerOrganisation,
                        stack, domain => boundedOwnershipString(domain, 253))
                })));
            return { schemaVersion: SCHEMA_VERSION, tenant, organisations };
        });
    } catch {
        fail('shape_invalid');
    }
    assertBytes(aggregate, EVIDENCE_LIMITS.ownershipBytes);
    let organisation;
    try {
        organisation = resolveOrganisation(aggregate, {
            tenantId: selector.tenantId, organisationId: selector.organisationId
        });
    } catch (error) {
        if (error.statusCode === 404 || error.code === 'tenant_domain_owner_mismatch') fail('not_found');
        fail('shape_invalid');
    }
    if (aggregate.tenant.recordStatus !== 'active' || organisation.recordStatus !== 'active') {
        fail('organisation_inactive');
    }
}

function ownershipRecord(row) {
    if (row.schemaVersion !== SCHEMA_VERSION || !['active', 'suspended', 'closed'].includes(row.recordStatus)) {
        fail('shape_invalid');
    }
    return { schemaVersion: SCHEMA_VERSION, tenantId: identifier(row.tenantId),
        displayName: boundedOwnershipString(row.displayName, 200), recordStatus: row.recordStatus,
        revision: revision(row.revision) };
}

function boundedOwnershipString(value, maximum) {
    if (typeof value !== 'string' || value.length === 0 || value.length > maximum || !validUnicode(value)) {
        fail('shape_invalid');
    }
    return value;
}

// Only descriptor-captured, closed data reaches normalizers. A path-local stack
// rejects cycles while permitting a caller to safely share a data object.
function record(input, fields, stack, normalize) {
    if (input === null || typeof input !== 'object' || types.isProxy(input) || Array.isArray(input)) {
        fail('shape_invalid');
    }
    const prototype = Object.getPrototypeOf(input);
    if ((prototype !== Object.prototype && prototype !== null) || stack.has(input)) fail('shape_invalid');
    const keys = Reflect.ownKeys(input);
    if (keys.length !== fields.length || keys.some(key => typeof key !== 'string' || !fields.includes(key))) {
        fail('shape_invalid');
    }
    const snapshot = Object.create(null);
    for (const field of fields) {
        const descriptor = Object.getOwnPropertyDescriptor(input, field);
        if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) fail('shape_invalid');
        snapshot[field] = descriptor.value;
    }
    stack.add(input);
    try { return normalize(snapshot); }
    finally { stack.delete(input); }
}

function collection(input, minimum, maximum, stack, normalize) {
    if (input === null || typeof input !== 'object' || types.isProxy(input) || !Array.isArray(input)) {
        fail('collection_invalid');
    }
    if (Object.getPrototypeOf(input) !== Array.prototype || stack.has(input)) fail('collection_invalid');
    const lengthDescriptor = Object.getOwnPropertyDescriptor(input, 'length');
    if (!lengthDescriptor || !Object.hasOwn(lengthDescriptor, 'value')) fail('collection_invalid');
    const length = lengthDescriptor.value;
    if (!Number.isSafeInteger(length) || length < minimum || length > maximum) fail('collection_invalid');
    const keys = Reflect.ownKeys(input);
    if (keys.length !== length + 1) fail('collection_invalid');
    const snapshot = [];
    for (let index = 0; index < length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
        if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) fail('collection_invalid');
        snapshot.push(descriptor.value);
    }
    stack.add(input);
    try { return snapshot.map((value, index) => normalize(value, index)); }
    finally { stack.delete(input); }
}

function validUnicode(value) {
    for (let index = 0; index < value.length; index += 1) {
        const unit = value.charCodeAt(index);
        if (unit >= 0xd800 && unit <= 0xdbff) {
            const next = value.charCodeAt(index + 1);
            if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
            index += 1;
        } else if (unit >= 0xdc00 && unit <= 0xdfff) return false;
    }
    return true;
}

function identifier(value) {
    if (typeof value !== 'string' || value.length === 0 || value.length > 180 ||
        value.trim() !== value || /[\u0000-\u001f\u007f]/.test(value) || !validUnicode(value)) fail('identifier_invalid');
    return value;
}

function nonnegativeInteger(value, code) {
    if (!Number.isSafeInteger(value) || value < 0 || Object.is(value, -0)) fail(code);
    return value;
}

function revision(value) { return nonnegativeInteger(value, 'revision_invalid'); }

function subject(value) {
    if (typeof value !== 'string' || value.length !== 73 || !SUBJECT.test(value)) fail('subject_invalid');
    return value;
}

function instant(value) {
    if (typeof value !== 'string' || value.length !== 24 ||
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) fail('time_invalid');
    const date = new Date(value);
    if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) fail('time_invalid');
    return value;
}

function digest(value) {
    if (typeof value !== 'string' || value.length !== 64 || !/^[0-9a-f]{64}$/.test(value)) fail('digest_invalid');
    return value;
}

function mime(value, code = 'content_invalid') {
    if (typeof value !== 'string' || value.length > 127 || value.trim() !== value || !MIME.test(value)) fail(code);
    return value;
}

function compareStrings(left, right) { return left < right ? -1 : left > right ? 1 : 0; }

// Called only on newly constructed data with validated primitives and bounded
// schema depth; never serializes the original caller object or its hooks.
function canonicalJson(value) {
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
    if (value !== null && typeof value === 'object') {
        return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
    }
    return JSON.stringify(value);
}

function assertBytes(value, maximum) {
    if (Buffer.byteLength(canonicalJson(value), 'utf8') > maximum) fail('payload_too_large');
}

function freeze(value) {
    if (value !== null && typeof value === 'object') {
        for (const child of Object.values(value)) freeze(child);
        Object.freeze(value);
    }
    return value;
}

module.exports = Object.freeze({
    SCHEMA_VERSION, EVIDENCE_LIMITS, EvidenceDomainError,
    normaliseEvidenceSelector, normaliseEvidenceCommand, normaliseEvidenceState,
    createEvidence, applyEvidenceCommand, evidenceCommandFingerprint
});
