'use strict';

const TENANT_DOMAIN_SCHEMA_VERSION = 1;
const MAX_IDENTIFIER_LENGTH = 180;
const MAX_DISPLAY_NAME_LENGTH = 200;
const MAX_DOMAIN_LENGTH = 253;

const DOMAIN_RECORD_STATUSES = Object.freeze({
    ACTIVE: 'active',
    SUSPENDED: 'suspended',
    CLOSED: 'closed'
});

const DOMAIN_RECORD_STATUS_VALUES = Object.freeze(Object.values(DOMAIN_RECORD_STATUSES));

const DOMAIN_RECORD_TRANSITIONS = Object.freeze({
    [DOMAIN_RECORD_STATUSES.ACTIVE]: Object.freeze([
        DOMAIN_RECORD_STATUSES.SUSPENDED,
        DOMAIN_RECORD_STATUSES.CLOSED
    ]),
    [DOMAIN_RECORD_STATUSES.SUSPENDED]: Object.freeze([
        DOMAIN_RECORD_STATUSES.ACTIVE,
        DOMAIN_RECORD_STATUSES.CLOSED
    ]),
    [DOMAIN_RECORD_STATUSES.CLOSED]: Object.freeze([])
});

class TenantDomainError extends Error {
    constructor(statusCode, message, code, details = {}) {
        super(message);
        this.name = 'TenantDomainError';
        this.statusCode = statusCode;
        this.code = code;
        this.details = Object.freeze({ code, ...details });
    }
}

function createTenant(input) {
    return normaliseTenant(input);
}

function createOrganisation(input) {
    return normaliseOrganisation(input);
}

function createTenantAggregate(input) {
    return normaliseTenantAggregate(input);
}

function normaliseTenant(input, options = {}) {
    const requireCanonical = options.requireCanonical === true;
    const source = assertDataObject(input, {
        allowed: ['schemaVersion', 'tenantId', 'displayName', 'recordStatus', 'revision'],
        required: requireCanonical
            ? ['schemaVersion', 'tenantId', 'displayName', 'recordStatus', 'revision']
            : ['tenantId', 'displayName'],
        code: 'tenant_domain_tenant_invalid'
    });

    return deepFreeze({
        schemaVersion: normaliseSchemaVersion(
            source.schemaVersion,
            { required: requireCanonical }
        ),
        tenantId: normaliseIdentifier(source.tenantId, 'tenantId'),
        displayName: normaliseDisplayName(source.displayName, 'tenant displayName'),
        recordStatus: normaliseRecordStatus(
            source.recordStatus,
            { required: requireCanonical }
        ),
        revision: normaliseRevision(
            source.revision,
            { required: requireCanonical }
        )
    });
}

function normaliseOrganisation(input, options = {}) {
    const requireCanonical = options.requireCanonical === true;
    const source = assertDataObject(input, {
        allowed: [
            'schemaVersion',
            'tenantId',
            'organisationId',
            'displayName',
            'domains',
            'recordStatus',
            'revision'
        ],
        required: requireCanonical
            ? [
                'schemaVersion',
                'tenantId',
                'organisationId',
                'displayName',
                'domains',
                'recordStatus',
                'revision'
            ]
            : ['tenantId', 'organisationId', 'displayName'],
        code: 'tenant_domain_organisation_invalid'
    });

    return deepFreeze({
        schemaVersion: normaliseSchemaVersion(
            source.schemaVersion,
            { required: requireCanonical }
        ),
        tenantId: normaliseIdentifier(source.tenantId, 'tenantId'),
        organisationId: normaliseIdentifier(source.organisationId, 'organisationId'),
        displayName: normaliseDisplayName(source.displayName, 'organisation displayName'),
        domains: normaliseDomains(source.domains, { required: requireCanonical }),
        recordStatus: normaliseRecordStatus(
            source.recordStatus,
            { required: requireCanonical }
        ),
        revision: normaliseRevision(
            source.revision,
            { required: requireCanonical }
        )
    });
}

function normaliseTenantAggregate(input, options = {}) {
    const requireCanonical = options.requireCanonical === true;
    const source = assertDataObject(input, {
        allowed: ['schemaVersion', 'tenant', 'organisations'],
        required: requireCanonical
            ? ['schemaVersion', 'tenant', 'organisations']
            : ['tenant', 'organisations'],
        code: 'tenant_domain_aggregate_invalid'
    });
    const schemaVersion = normaliseSchemaVersion(
        source.schemaVersion,
        { required: requireCanonical }
    );
    const tenant = normaliseTenant(source.tenant, { requireCanonical });
    const organisationInputs = normaliseDataArray(
        source.organisations,
        'tenant_domain_organisations_invalid'
    );
    if (organisationInputs.length === 0) {
        throw domainError(
            400,
            'Tenant aggregate must contain at least one organisation',
            'tenant_domain_organisations_empty'
        );
    }
    const organisations = organisationInputs.map((organisationInput) => (
        normaliseOrganisation(organisationInput, { requireCanonical })
    ));
    const seen = new Set();

    for (const organisation of organisations) {
        if (organisation.tenantId !== tenant.tenantId) {
            throw domainError(
                409,
                'Organisation owner does not match the tenant aggregate',
                'tenant_domain_owner_mismatch'
            );
        }
        if (seen.has(organisation.organisationId)) {
            throw domainError(
                409,
                'Organisation identifier is duplicated inside the tenant',
                'tenant_domain_organisation_duplicate'
            );
        }
        seen.add(organisation.organisationId);
    }

    return deepFreeze({
        schemaVersion,
        tenant,
        organisations
    });
}

function resolveOrganisation(aggregateInput, selectorInput) {
    const aggregate = normaliseTenantAggregate(aggregateInput, { requireCanonical: true });
    const selector = assertDataObject(selectorInput, {
        allowed: ['tenantId', 'organisationId'],
        required: ['tenantId', 'organisationId'],
        code: 'tenant_domain_selector_invalid'
    });
    const tenantId = normaliseIdentifier(selector.tenantId, 'tenantId');
    const organisationId = normaliseIdentifier(selector.organisationId, 'organisationId');

    if (tenantId !== aggregate.tenant.tenantId) {
        throw organisationNotFound();
    }

    const organisation = aggregate.organisations.find((candidate) => (
        candidate.tenantId === tenantId &&
        candidate.organisationId === organisationId
    ));
    if (!organisation) throw organisationNotFound();
    return organisation;
}

function transitionTenant(tenantInput, transitionInput) {
    return transitionRecord(
        normaliseTenant(tenantInput, { requireCanonical: true }),
        transitionInput,
        (record) => normaliseTenant(record, { requireCanonical: true })
    );
}

function transitionOrganisation(organisationInput, transitionInput) {
    return transitionRecord(
        normaliseOrganisation(organisationInput, { requireCanonical: true }),
        transitionInput,
        (record) => normaliseOrganisation(record, { requireCanonical: true })
    );
}

function transitionRecord(record, transitionInput, normaliseRecord) {
    const transition = assertDataObject(transitionInput, {
        allowed: ['expectedRevision', 'toStatus'],
        required: ['expectedRevision', 'toStatus'],
        code: 'tenant_domain_transition_invalid'
    });
    const expectedRevision = normaliseRevision(
        transition.expectedRevision,
        { required: true, field: 'expectedRevision' }
    );
    const toStatus = normaliseRecordStatus(transition.toStatus, { required: true });

    if (expectedRevision !== record.revision) {
        throw domainError(
            409,
            'Tenant-domain record changed while it was being updated',
            'tenant_domain_revision_conflict',
            { currentRevision: record.revision }
        );
    }
    if (!DOMAIN_RECORD_TRANSITIONS[record.recordStatus].includes(toStatus)) {
        throw domainError(
            409,
            'Tenant-domain lifecycle transition is not allowed',
            'tenant_domain_transition_not_allowed',
            { fromStatus: record.recordStatus, toStatus }
        );
    }
    if (!Number.isSafeInteger(record.revision + 1)) {
        throw domainError(
            409,
            'Tenant-domain record revision cannot be advanced safely',
            'tenant_domain_revision_exhausted'
        );
    }

    return normaliseRecord({
        ...record,
        recordStatus: toStatus,
        revision: record.revision + 1
    });
}

function normaliseSchemaVersion(value, options = {}) {
    if (value === undefined && !options.required) return TENANT_DOMAIN_SCHEMA_VERSION;
    if (value !== TENANT_DOMAIN_SCHEMA_VERSION) {
        throw domainError(
            400,
            'Tenant-domain schema version is unsupported',
            'tenant_domain_schema_version_unsupported'
        );
    }
    return value;
}

function normaliseIdentifier(value, field) {
    if (typeof value !== 'string') {
        throw domainError(400, `${field} must be an opaque internal string`, 'tenant_domain_identifier_invalid', { field });
    }
    const trimmed = value.trim();
    if (
        !trimmed ||
        trimmed !== value ||
        trimmed.length > MAX_IDENTIFIER_LENGTH ||
        /[\u0000-\u001f\u007f]/.test(trimmed)
    ) {
        throw domainError(400, `${field} is not a valid opaque internal identifier`, 'tenant_domain_identifier_invalid', { field });
    }
    return trimmed;
}

function normaliseDisplayName(value, field) {
    if (typeof value !== 'string') {
        throw domainError(400, `${field} must be a string`, 'tenant_domain_display_name_invalid', { field });
    }
    const trimmed = value.trim();
    if (!trimmed || trimmed.length > MAX_DISPLAY_NAME_LENGTH || /[\u0000-\u001f\u007f]/.test(trimmed)) {
        throw domainError(400, `${field} is invalid`, 'tenant_domain_display_name_invalid', { field });
    }
    return trimmed;
}

function normaliseDomains(value, options = {}) {
    if (value === undefined && !options.required) return Object.freeze([]);
    const domains = normaliseDataArray(value, 'tenant_domain_domains_invalid');
    const seen = new Set();
    const result = [];

    for (const candidate of domains) {
        if (typeof candidate !== 'string') {
            throw domainError(400, 'Organisation domains must be strings', 'tenant_domain_domain_invalid');
        }
        const domain = candidate.trim().toLowerCase();
        if (
            !domain ||
            domain.length > MAX_DOMAIN_LENGTH ||
            /[\s\/@\u0000-\u001f\u007f]/.test(domain) ||
            domain.startsWith('.') ||
            domain.endsWith('.')
        ) {
            throw domainError(400, 'Organisation domain metadata is invalid', 'tenant_domain_domain_invalid');
        }
        if (!seen.has(domain)) {
            seen.add(domain);
            result.push(domain);
        }
    }
    return Object.freeze(result);
}

function normaliseRecordStatus(value, options = {}) {
    const status = value === undefined && !options.required
        ? DOMAIN_RECORD_STATUSES.ACTIVE
        : value;
    if (!DOMAIN_RECORD_STATUS_VALUES.includes(status)) {
        throw domainError(400, 'Tenant-domain record status is invalid', 'tenant_domain_status_invalid');
    }
    return status;
}

function normaliseRevision(value, options = {}) {
    if (value === undefined && !options.required) return 0;
    if (!Number.isSafeInteger(value) || value < 0) {
        throw domainError(
            400,
            `${options.field || 'revision'} must be a non-negative safe integer`,
            'tenant_domain_revision_invalid'
        );
    }
    return value;
}

function normaliseDataArray(value, code) {
    if (!Array.isArray(value)) {
        throw domainError(400, 'Tenant-domain collection must be an array', code);
    }
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key === 'symbol')) {
        throw domainError(400, 'Tenant-domain collection contains an unsupported key', code);
    }
    const result = new Array(value.length);
    for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
            throw domainError(400, 'Tenant-domain collection must be dense data', code);
        }
        result[index] = descriptor.value;
    }
    const extraKeys = keys.filter((key) => {
        if (key === 'length') return false;
        if (typeof key !== 'string' || !/^(0|[1-9][0-9]*)$/.test(key)) return true;
        const index = Number(key);
        return !Number.isSafeInteger(index) || index < 0 || index >= value.length;
    });
    if (extraKeys.length) {
        throw domainError(400, 'Tenant-domain collection contains an unsupported key', code);
    }
    return result;
}

function assertDataObject(value, { allowed, required, code }) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw domainError(400, 'Tenant-domain input must be a data object', code);
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
        throw domainError(400, 'Tenant-domain input prototype is invalid', code);
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key === 'symbol')) {
        throw domainError(400, 'Tenant-domain input contains an unsupported key', code);
    }
    for (const key of keys) {
        const descriptor = descriptors[key];
        if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
            throw domainError(400, 'Tenant-domain input must not contain accessors', code);
        }
    }
    const unexpected = keys.filter((key) => !allowed.includes(key));
    const missing = required.filter((key) => !Object.prototype.hasOwnProperty.call(descriptors, key));
    if (unexpected.length || missing.length) {
        throw domainError(
            400,
            'Tenant-domain input shape is invalid',
            code,
            { unexpected: unexpected.sort(), missing: missing.sort() }
        );
    }

    const snapshot = Object.create(null);
    for (const key of keys) {
        snapshot[key] = descriptors[key].value;
    }
    return snapshot;
}

function organisationNotFound() {
    return domainError(
        404,
        'Organisation was not found in the selected tenant',
        'tenant_domain_organisation_not_found'
    );
}

function domainError(statusCode, message, code, details = {}) {
    return new TenantDomainError(statusCode, message, code, details);
}

function deepFreeze(value) {
    if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
    Object.values(value).forEach(deepFreeze);
    return Object.freeze(value);
}

module.exports = {
    DOMAIN_RECORD_STATUSES,
    DOMAIN_RECORD_TRANSITIONS,
    TENANT_DOMAIN_SCHEMA_VERSION,
    TenantDomainError,
    createOrganisation,
    createTenant,
    createTenantAggregate,
    resolveOrganisation,
    transitionOrganisation,
    transitionTenant
};
