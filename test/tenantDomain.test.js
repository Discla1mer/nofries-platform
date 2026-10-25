'use strict';

const fs = require('fs');
const {
    DOMAIN_RECORD_STATUSES,
    TENANT_DOMAIN_SCHEMA_VERSION,
    TenantDomainError,
    createOrganisation,
    createTenant,
    createTenantAggregate,
    resolveOrganisation,
    transitionOrganisation,
    transitionTenant
} = require('../api/shared/appLifecycle/tenantDomain');

function captureError(operation) {
    try {
        operation();
    } catch (error) {
        return error;
    }
    throw new Error('Expected operation to fail');
}

function tenant(overrides = {}) {
    return createTenant({
        tenantId: 'tenant:NoFries-01',
        displayName: 'No Fries workspace',
        ...overrides
    });
}

function organisation(overrides = {}) {
    return createOrganisation({
        tenantId: 'tenant:NoFries-01',
        organisationId: 'organisation_8D1E6A5C',
        displayName: 'No Fries HQ',
        domains: ['NoFries.NZ'],
        ...overrides
    });
}

describe('dashboard-only tenant domain', () => {
    test('creates an active tenant and organisation without provider or service identifiers', () => {
        const aggregate = createTenantAggregate({
            tenant: tenant(),
            organisations: [organisation()]
        });

        expect(aggregate).toEqual({
            schemaVersion: TENANT_DOMAIN_SCHEMA_VERSION,
            tenant: {
                schemaVersion: TENANT_DOMAIN_SCHEMA_VERSION,
                tenantId: 'tenant:NoFries-01',
                displayName: 'No Fries workspace',
                recordStatus: DOMAIN_RECORD_STATUSES.ACTIVE,
                revision: 0
            },
            organisations: [{
                schemaVersion: TENANT_DOMAIN_SCHEMA_VERSION,
                tenantId: 'tenant:NoFries-01',
                organisationId: 'organisation_8D1E6A5C',
                displayName: 'No Fries HQ',
                domains: ['nofries.nz'],
                recordStatus: DOMAIN_RECORD_STATUSES.ACTIVE,
                revision: 0
            }]
        });

        expect(Object.isFrozen(aggregate)).toBe(true);
        expect(Object.isFrozen(aggregate.tenant)).toBe(true);
        expect(Object.isFrozen(aggregate.organisations)).toBe(true);
        expect(Object.isFrozen(aggregate.organisations[0])).toBe(true);
        expect(Object.isFrozen(aggregate.organisations[0].domains)).toBe(true);
        expect(() => aggregate.organisations.push(organisation())).toThrow(TypeError);

        expect(JSON.stringify(aggregate)).not.toMatch(
            /autotask|datto|rmm|mdr|provider|device|support|advisory|membership|entitlement/i
        );
    });

    test('round-trips canonical aggregates and fails closed on aggregate schema drift', () => {
        const aggregate = createTenantAggregate({
            tenant: tenant(),
            organisations: [organisation()]
        });

        expect(createTenantAggregate(aggregate)).toEqual(aggregate);
        expect(resolveOrganisation(aggregate, {
            tenantId: aggregate.tenant.tenantId,
            organisationId: aggregate.organisations[0].organisationId
        })).toEqual(aggregate.organisations[0]);

        for (const schemaVersion of [null, 2]) {
            expect(captureError(() => createTenantAggregate({
                ...aggregate,
                schemaVersion
            }))).toMatchObject({
                code: 'tenant_domain_schema_version_unsupported'
            });
        }
    });

    test('supports one tenant with several organisations while names and domains remain metadata', () => {
        const aggregate = createTenantAggregate({
            tenant: tenant(),
            organisations: [
                organisation(),
                organisation({
                    organisationId: 'organisation_south',
                    displayName: 'No Fries HQ',
                    domains: ['nofries.nz']
                })
            ]
        });

        expect(aggregate.organisations).toHaveLength(2);
        expect(resolveOrganisation(aggregate, {
            tenantId: 'tenant:NoFries-01',
            organisationId: 'organisation_south'
        }).organisationId).toBe('organisation_south');

        const wrongTenant = captureError(() => resolveOrganisation(aggregate, {
            tenantId: 'tenant:other',
            organisationId: 'organisation_south'
        }));
        const wrongOrganisation = captureError(() => resolveOrganisation(aggregate, {
            tenantId: 'tenant:NoFries-01',
            organisationId: 'organisation_missing'
        }));
        expect(wrongTenant).toMatchObject({
            statusCode: 404,
            code: 'tenant_domain_organisation_not_found'
        });
        expect(wrongOrganisation).toMatchObject({
            statusCode: 404,
            code: 'tenant_domain_organisation_not_found'
        });
        expect({
            message: wrongTenant.message,
            details: wrongTenant.details
        }).toEqual({
            message: wrongOrganisation.message,
            details: wrongOrganisation.details
        });
    });

    test('enforces one-or-more organisations, exactly one owner and no duplicates', () => {
        const empty = captureError(() => createTenantAggregate({
            tenant: tenant(),
            organisations: []
        }));
        expect(empty).toMatchObject({
            statusCode: 400,
            code: 'tenant_domain_organisations_empty'
        });

        const ownerMismatch = captureError(() => createTenantAggregate({
            tenant: tenant(),
            organisations: [organisation({ tenantId: 'tenant:other' })]
        }));
        expect(ownerMismatch).toMatchObject({
            statusCode: 409,
            code: 'tenant_domain_owner_mismatch'
        });

        const duplicate = captureError(() => createTenantAggregate({
            tenant: tenant(),
            organisations: [organisation(), organisation()]
        }));
        expect(duplicate).toMatchObject({
            statusCode: 409,
            code: 'tenant_domain_organisation_duplicate'
        });

        const first = createTenantAggregate({
            tenant: tenant(),
            organisations: [organisation()]
        });
        const second = createTenantAggregate({
            tenant: tenant({
                tenantId: 'tenant:other',
                displayName: 'Other workspace'
            }),
            organisations: [organisation({ tenantId: 'tenant:other' })]
        });
        expect(first.organisations[0].organisationId)
            .toBe(second.organisations[0].organisationId);
    });

    test('copies validated array data without invoking an inherited iterator', () => {
        let iteratorInvoked = false;
        const organisations = [organisation()];
        const customPrototype = Object.create(Array.prototype);
        Object.defineProperty(customPrototype, Symbol.iterator, {
            value() {
                iteratorInvoked = true;
                throw new Error('must not execute');
            }
        });
        Object.setPrototypeOf(organisations, customPrototype);

        const aggregate = createTenantAggregate({
            tenant: tenant(),
            organisations
        });

        expect(iteratorInvoked).toBe(false);
        expect(aggregate.organisations).toHaveLength(1);
        expect(aggregate.organisations[0].organisationId)
            .toBe('organisation_8D1E6A5C');

        const nonIndexProperty = [organisation()];
        Object.defineProperty(nonIndexProperty, '4294967295', {
            enumerable: true,
            value: organisation({ organisationId: 'silently-dropped' })
        });
        expect(captureError(() => createTenantAggregate({
            tenant: tenant(),
            organisations: nonIndexProperty
        }))).toMatchObject({
            code: 'tenant_domain_organisations_invalid'
        });
    });

    test('treats opaque identifiers case-sensitively and never derives them from names or domains', () => {
        const record = organisation({
            tenantId: 'TENANT:Mixed_Case',
            organisationId: 'Org:Mixed_Case',
            displayName: 'Repeated Name',
            domains: ['Shared.Example']
        });

        expect(record).toMatchObject({
            tenantId: 'TENANT:Mixed_Case',
            organisationId: 'Org:Mixed_Case',
            displayName: 'Repeated Name',
            domains: ['shared.example']
        });
        const other = organisation({
            tenantId: 'tenant:mixed_case',
            organisationId: 'org:mixed_case',
            displayName: 'Repeated Name',
            domains: ['shared.example']
        });
        expect(other.tenantId).not.toBe(record.tenantId);
        expect(other.organisationId).not.toBe(record.organisationId);
    });

    test('rejects unknown and provider-shaped fields instead of accepting them as authority', () => {
        for (const [field, value] of [
            ['autotaskCompanyId', 'external-company'],
            ['dattoSiteUid', 'external-site'],
            ['rmmSiteId', 'external-rmm'],
            ['mdrTenantId', 'external-mdr'],
            ['providerBindings', []],
            ['memberships', []],
            ['entitlements', []],
            ['blobPath', 'tenant/customer.json']
        ]) {
            const error = captureError(() => createOrganisation({
                tenantId: 'tenant:NoFries-01',
                organisationId: 'organisation_8D1E6A5C',
                displayName: 'No Fries HQ',
                [field]: value
            }));
            expect(error).toBeInstanceOf(TenantDomainError);
            expect(error).toMatchObject({
                statusCode: 400,
                code: 'tenant_domain_organisation_invalid',
                details: expect.objectContaining({ unexpected: [field] })
            });
        }
    });

    test('copies and deeply freezes records without mutating caller-owned metadata', () => {
        const domains = ['Example.NZ', 'example.nz'];
        const record = organisation({ domains });

        domains.push('later.example');
        expect(record.domains).toEqual(['example.nz']);
        expect(Object.isFrozen(record)).toBe(true);
        expect(Object.isFrozen(record.domains)).toBe(true);
        expect(() => record.domains.push('blocked.example')).toThrow(TypeError);
    });

    test('requires complete canonical records before lookup and lifecycle transitions', () => {
        const closedTenant = tenant({
            recordStatus: DOMAIN_RECORD_STATUSES.CLOSED,
            revision: 2
        });
        const closedOrganisation = organisation({
            recordStatus: DOMAIN_RECORD_STATUSES.CLOSED,
            revision: 2
        });
        const variants = (record, fields) => fields.flatMap((field) => {
            const omitted = { ...record };
            delete omitted[field];
            return [omitted, { ...record, [field]: undefined }];
        });

        for (const candidate of variants(
            closedTenant,
            ['schemaVersion', 'recordStatus', 'revision']
        )) {
            expect(captureError(() => transitionTenant(candidate, {
                expectedRevision: candidate.revision === undefined ? 0 : 2,
                toStatus: DOMAIN_RECORD_STATUSES.SUSPENDED
            }))).toMatchObject({ statusCode: 400 });
        }

        for (const candidate of variants(
            closedOrganisation,
            ['schemaVersion', 'domains', 'recordStatus', 'revision']
        )) {
            expect(captureError(() => transitionOrganisation(candidate, {
                expectedRevision: candidate.revision === undefined ? 0 : 2,
                toStatus: DOMAIN_RECORD_STATUSES.SUSPENDED
            }))).toMatchObject({ statusCode: 400 });
        }

        const aggregate = createTenantAggregate({
            tenant: closedTenant,
            organisations: [closedOrganisation]
        });
        const selector = {
            tenantId: closedTenant.tenantId,
            organisationId: closedOrganisation.organisationId
        };
        const aggregateVariants = variants(aggregate, ['schemaVersion']);
        for (const candidate of variants(
            closedTenant,
            ['schemaVersion', 'recordStatus', 'revision']
        )) {
            aggregateVariants.push({ ...aggregate, tenant: candidate });
        }
        for (const candidate of variants(
            closedOrganisation,
            ['schemaVersion', 'domains', 'recordStatus', 'revision']
        )) {
            aggregateVariants.push({ ...aggregate, organisations: [candidate] });
        }

        for (const candidate of aggregateVariants) {
            expect(captureError(() => resolveOrganisation(candidate, selector)))
                .toMatchObject({ statusCode: 400 });
        }
        expect(resolveOrganisation(aggregate, selector).recordStatus)
            .toBe(DOMAIN_RECORD_STATUSES.CLOSED);

        const projectedClosed = {
            tenantId: closedOrganisation.tenantId,
            organisationId: closedOrganisation.organisationId,
            displayName: closedOrganisation.displayName,
            domains: closedOrganisation.domains
        };
        expect(captureError(() => transitionOrganisation(projectedClosed, {
            expectedRevision: 0,
            toStatus: DOMAIN_RECORD_STATUSES.SUSPENDED
        }))).toMatchObject({
            statusCode: 400,
            code: 'tenant_domain_organisation_invalid'
        });

        const exhausted = organisation({ revision: Number.MAX_SAFE_INTEGER });
        expect(captureError(() => transitionOrganisation(exhausted, {
            expectedRevision: Number.MAX_SAFE_INTEGER,
            toStatus: DOMAIN_RECORD_STATUSES.SUSPENDED
        }))).toMatchObject({
            statusCode: 409,
            code: 'tenant_domain_revision_exhausted'
        });
    });

    test('enforces every lifecycle edge and rejects same-state, closed-state, stale and future updates', () => {
        for (const [fromStatus, toStatus] of [
            [DOMAIN_RECORD_STATUSES.ACTIVE, DOMAIN_RECORD_STATUSES.SUSPENDED],
            [DOMAIN_RECORD_STATUSES.ACTIVE, DOMAIN_RECORD_STATUSES.CLOSED],
            [DOMAIN_RECORD_STATUSES.SUSPENDED, DOMAIN_RECORD_STATUSES.ACTIVE],
            [DOMAIN_RECORD_STATUSES.SUSPENDED, DOMAIN_RECORD_STATUSES.CLOSED]
        ]) {
            expect(transitionOrganisation(organisation({
                recordStatus: fromStatus,
                revision: 4
            }), {
                expectedRevision: 4,
                toStatus
            })).toMatchObject({
                recordStatus: toStatus,
                revision: 5
            });
        }

        for (const [fromStatus, toStatus] of [
            [DOMAIN_RECORD_STATUSES.ACTIVE, DOMAIN_RECORD_STATUSES.ACTIVE],
            [DOMAIN_RECORD_STATUSES.SUSPENDED, DOMAIN_RECORD_STATUSES.SUSPENDED],
            [DOMAIN_RECORD_STATUSES.CLOSED, DOMAIN_RECORD_STATUSES.ACTIVE],
            [DOMAIN_RECORD_STATUSES.CLOSED, DOMAIN_RECORD_STATUSES.SUSPENDED],
            [DOMAIN_RECORD_STATUSES.CLOSED, DOMAIN_RECORD_STATUSES.CLOSED]
        ]) {
            expect(captureError(() => transitionOrganisation(organisation({
                recordStatus: fromStatus,
                revision: 4
            }), {
                expectedRevision: 4,
                toStatus
            }))).toMatchObject({
                statusCode: 409,
                code: 'tenant_domain_transition_not_allowed',
                details: expect.objectContaining({ fromStatus, toStatus })
            });
        }

        const current = organisation({ revision: 4 });
        for (const expectedRevision of [3, 5]) {
            expect(captureError(() => transitionOrganisation(current, {
                expectedRevision,
                toStatus: DOMAIN_RECORD_STATUSES.SUSPENDED
            }))).toMatchObject({
                statusCode: 409,
                code: 'tenant_domain_revision_conflict',
                details: expect.objectContaining({ currentRevision: 4 })
            });
        }
    });

    test('applies explicit lifecycle edges with optimistic revision checks and terminal closure', () => {
        const original = organisation();
        const suspended = transitionOrganisation(original, {
            expectedRevision: 0,
            toStatus: DOMAIN_RECORD_STATUSES.SUSPENDED
        });
        const resumed = transitionOrganisation(suspended, {
            expectedRevision: 1,
            toStatus: DOMAIN_RECORD_STATUSES.ACTIVE
        });
        const closed = transitionOrganisation(resumed, {
            expectedRevision: 2,
            toStatus: DOMAIN_RECORD_STATUSES.CLOSED
        });

        expect(original.recordStatus).toBe(DOMAIN_RECORD_STATUSES.ACTIVE);
        expect(suspended).toMatchObject({
            tenantId: original.tenantId,
            organisationId: original.organisationId,
            recordStatus: DOMAIN_RECORD_STATUSES.SUSPENDED,
            revision: 1
        });
        expect(resumed.revision).toBe(2);
        expect(closed.revision).toBe(3);
        expect(Object.isFrozen(closed)).toBe(true);

        const missingTarget = captureError(() => transitionOrganisation(suspended, {
            expectedRevision: 1,
            toStatus: undefined
        }));
        expect(missingTarget).toMatchObject({
            statusCode: 400,
            code: 'tenant_domain_status_invalid'
        });

        const stale = captureError(() => transitionOrganisation(suspended, {
            expectedRevision: 0,
            toStatus: DOMAIN_RECORD_STATUSES.CLOSED
        }));
        expect(stale).toMatchObject({
            statusCode: 409,
            code: 'tenant_domain_revision_conflict',
            details: expect.objectContaining({ currentRevision: 1 })
        });

        const reopened = captureError(() => transitionOrganisation(closed, {
            expectedRevision: 3,
            toStatus: DOMAIN_RECORD_STATUSES.ACTIVE
        }));
        expect(reopened).toMatchObject({
            statusCode: 409,
            code: 'tenant_domain_transition_not_allowed'
        });
    });

    test('uses the same bounded lifecycle for the tenant record without granting access', () => {
        const suspended = transitionTenant(tenant(), {
            expectedRevision: 0,
            toStatus: DOMAIN_RECORD_STATUSES.SUSPENDED
        });
        const closed = transitionTenant(suspended, {
            expectedRevision: 1,
            toStatus: DOMAIN_RECORD_STATUSES.CLOSED
        });

        expect(closed).toMatchObject({
            tenantId: 'tenant:NoFries-01',
            recordStatus: DOMAIN_RECORD_STATUSES.CLOSED,
            revision: 2
        });
        expect(closed).not.toHaveProperty('allowed');
        expect(closed).not.toHaveProperty('capabilities');
    });

    test('fails closed on invalid identifiers, status, revision, schema and data shapes', () => {
        const maximumLengthId = 'i'.repeat(180);
        expect(tenant({ tenantId: maximumLengthId }).tenantId).toBe(maximumLengthId);

        for (const invalidId of [
            '',
            ' padded',
            'padded ',
            'bad\nvalue',
            'i'.repeat(181),
            42
        ]) {
            expect(captureError(() => tenant({ tenantId: invalidId })))
                .toMatchObject({ code: 'tenant_domain_identifier_invalid' });
        }
        expect(captureError(() => organisation({ recordStatus: 'onboarding' })))
            .toMatchObject({ code: 'tenant_domain_status_invalid' });
        expect(captureError(() => organisation({ revision: -1 })))
            .toMatchObject({ code: 'tenant_domain_revision_invalid' });
        expect(captureError(() => organisation({ schemaVersion: 2 })))
            .toMatchObject({ code: 'tenant_domain_schema_version_unsupported' });

        for (const [field, code] of [
            ['schemaVersion', 'tenant_domain_schema_version_unsupported'],
            ['recordStatus', 'tenant_domain_status_invalid'],
            ['revision', 'tenant_domain_revision_invalid'],
            ['domains', 'tenant_domain_domains_invalid']
        ]) {
            expect(captureError(() => organisation({ [field]: null })))
                .toMatchObject({ code });
        }

        let inheritedGetterInvoked = false;
        Object.defineProperty(Object.prototype, 'schemaVersion', {
            configurable: true,
            get() {
                inheritedGetterInvoked = true;
                throw new Error('must not execute');
            }
        });
        try {
            const record = tenant();
            expect(record.schemaVersion).toBe(TENANT_DOMAIN_SCHEMA_VERSION);
            expect(inheritedGetterInvoked).toBe(false);
        } finally {
            delete Object.prototype.schemaVersion;
        }

        const accessor = {};
        Object.defineProperty(accessor, 'tenantId', {
            enumerable: true,
            get() {
                throw new Error('must not execute');
            }
        });
        accessor.displayName = 'Accessor';
        expect(captureError(() => createTenant(accessor)))
            .toMatchObject({ code: 'tenant_domain_tenant_invalid' });

        const inherited = Object.create({ organisationId: 'inherited' });
        inherited.tenantId = 'tenant:NoFries-01';
        inherited.displayName = 'Inherited';
        expect(captureError(() => createOrganisation(inherited)))
            .toMatchObject({ code: 'tenant_domain_organisation_invalid' });
    });

    test('keeps the new domain contract isolated from runtime, access, persistence and providers', () => {
        const source = fs.readFileSync(
            require.resolve('../api/shared/appLifecycle/tenantDomain'),
            'utf8'
        );

        expect(source).not.toMatch(/\brequire\s*\(/);
        expect(source).not.toMatch(
            /tenantAccess|appLifecycleRuntime|Repository|postgres|database|provider|autotask|datto|rmm|mdr/i
        );
    });
});
