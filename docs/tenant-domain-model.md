# Dashboard-only tenant domain

Status: POR-002 source contract. Dormant and not connected to a live route.

## Purpose

The module at `api/shared/appLifecycle/tenantDomain.js` represents the
No Fries-owned customer boundary defined by ADR-002 without requiring a
managed-service or supplier relationship.

It deliberately separates four concepts:

| Concept | POR-002 treatment |
|---|---|
| Tenant | Opaque No Fries security/accounting owner that may contain one or more organisations |
| Organisation | Opaque No Fries customer record that belongs to exactly one tenant |
| Display name and domains | Mutable descriptive metadata; never ownership or authority keys |
| Membership, entitlements and provider bindings | Separate later records and gates; absent from this contract |

A valid dashboard-only aggregate therefore needs no Autotask, Datto RMM, MDR,
device, support, advisory, membership, entitlement, or other provider
identifier.

## Contract

A tenant record has exactly these fields:

```js
{
    schemaVersion: 1,
    tenantId: 'opaque-No-Fries-id',
    displayName: 'Customer workspace',
    recordStatus: 'active',
    revision: 0
}
```

An organisation record has exactly these fields:

```js
{
    schemaVersion: 1,
    tenantId: 'opaque-No-Fries-id',
    organisationId: 'opaque-No-Fries-id',
    displayName: 'Customer organisation',
    domains: ['example.nz'],
    recordStatus: 'active',
    revision: 0
}
```

Identifiers are caller-supplied, immutable, case-sensitive, and compared
without derivation. The implementation does not lower-case, slugify, hash,
decode, or infer them from a name, domain, Entra identifier, supplier record,
or Blob path. The aggregate permits one tenant to own several organisations,
requires every contained organisation to repeat the exact owning `tenantId`,
and rejects a duplicate `organisationId` within that tenant.

An `organisationId` is tenant-scoped. The same opaque value may occur in a
different tenant, but an organisation is resolved only with the composite
`tenantId` plus `organisationId` selector. A wrong tenant and a missing
organisation intentionally produce the same not-found result.

`displayName` and `domains` are copied into immutable output as metadata.
Domain values are normalised for presentation and deduplicated. They are never
used to select, own, admit, or authorise an organisation.

## Record lifecycle

Tenant and organisation records use the same administrative record states:

| From | Allowed target |
|---|---|
| `active` | `suspended`, `closed` |
| `suspended` | `active`, `closed` |
| `closed` | none |

Each transition requires the caller's exact `expectedRevision` and increments
the revision once. Same-state, skipped, stale, and post-closure transitions
fail closed. Inputs are never mutated and returned records are deeply frozen.

The exported creation initialisers apply schema, active-status, zero-revision,
and empty-domain defaults only when creating a brand-new record. Lifecycle
transitions and aggregate lookup treat their inputs as existing or rehydrated
state: every canonical field must be present as own data, and omission or
explicit `undefined` fails closed. A later persistence adapter must read and
compare the current revision atomically before it writes the transitioned
record; reconstructing lifecycle state from identifiers and display metadata is
not valid rehydration.

`recordStatus` means only whether this ownership record is administratively
active, suspended, or closed. It is not a customer admission decision and
grants no authentication, membership, role, capability, entitlement, support
service, provider action, or portal access. In particular, an `active` record
must never be treated as sufficient evidence for a service-desk or provider
write.

This lifecycle is intentionally distinct from the existing App managed-service
journey and its onboarding and service-status controls. POR-002 does not
synchronise or replace those states.

## Validation and failure behaviour

The module accepts only plain data objects and dense arrays. It rejects
accessors, inherited object prototypes, symbols, unknown fields, unsupported
schema versions, malformed identifiers, invalid revisions, unsupported status
values, owner mismatch, and duplicate organisation identifiers.

Strict allowed-field validation is intentional. Supplier-shaped fields such as
provider mappings or external references cannot silently enter the ownership
record and later be mistaken for authority.

The module is pure: it imports no authentication, tenant-access, provider,
repository, database, runtime, route, or connector code and performs no I/O.

## Compatibility and migration effect

POR-002 is a zero-data-migration addition.

Current live Blob-backed state and the existing App lifecycle remain
authoritative for production behaviour. PostgreSQL/RLS remains opt-in under its
existing controls. This work performs:

- no SQL or schema migration;
- no schema-version bump to a live envelope;
- no existing-record backfill or rewrite;
- no dual read or dual write;
- no provider synchronisation;
- no route, UI, authentication, membership, entitlement, admission, or RBAC
  change;
- no production activation or deployment.

Existing organisation identifiers are to be preserved byte-for-byte when a
later, separately governed integration maps live data into this contract. An
existing canonical numeric revision must also be preserved exactly. If a live
source has no compatible revision, the mapping plan must define and persist a
one-time deterministic initial revision before any transition; it must never
reset or reconstruct revision zero for an existing record. Every later write
must atomically compare the persisted revision and advance it once. That
integration must define an idempotent mapping and collision policy before it
writes data.

The new `tenantId` must not automatically be equated with any current value
named “tenant”, including:

- `access.tenant.id`;
- `access.tenant.key`;
- `nofries.tenants.tenant_id`;
- `nofries.tenants.logical_id`.

Those current fields serve existing authentication, workspace, or physical
persistence purposes. Reusing one without an explicit reviewed mapping could
collapse distinct security boundaries or rewrite ownership. POR-002 makes no
such mapping.

Membership and invitations are deferred to POR-003, commercial entitlements to
POR-004, portal admission and RBAC to POR-005, and provider bindings to POR-006.
Persistence cutover remains a separate migration and release decision.

## Recovery

Because no runtime imports the module and no data is written, rollback is the
removal of:

- `api/shared/appLifecycle/tenantDomain.js`;
- `test/tenantDomain.test.js`;
- this document;
- the POR-002 ExecPlan.

No customer data restore, configuration rollback, provider reversal, or
production release is required.
