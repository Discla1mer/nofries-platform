# Tenant-bound invitations and memberships

Status: POR-003 source contract; dormant and not wired into portal admission.

`api/shared/appLifecycle/membershipDomain.js` models the relationship between
one No Fries organisation and an immutable authenticated identity. It requires
no Autotask, RMM, MDR, email, domain or supplier identifier.

## Boundary

This module is **not** an authentication or authorisation service. A valid
command or active membership record does not grant portal access, provider
actions, permissions or entitlements. Existing runtime access remains unchanged.

A future trusted service must independently authenticate the principal, derive
the tenant and organisation context, authorise every administrative command,
enforce roles and entitlements, supply trusted time and current tenant state,
and atomically persist the aggregate. Browser input must never become this
trusted context by being copied into a command. In particular, `actorSubjectKey`
is not proof of authentication and an administrator's subject is not proof of
permission to invite, suspend, resume, revoke or remove anyone.

The invitation is bound to an already resolved canonical Entra `tid:oid` subject
in lower-case UUID form, consistent with ADR-002. Email and display names cannot
substitute for that identity. Invitation delivery and onboarding an identity
whose immutable subject is not yet known are separate integration work. This
module does not generate bearer links or tokens, send messages or contact users.

## Aggregate and commands

`createMembershipState(tenantAggregate, { tenantId, organisationId }, now)` creates
only empty revision-zero state after resolving an active organisation and tenant
through the POR-002 tenant-domain contract. `normaliseMembershipState(state)`
rehydrates complete canonical state; it never supplies missing lifecycle defaults.
All outputs are detached, deeply frozen plain data.

Each aggregate contains exactly `schemaVersion`, `tenantId`, `organisationId`,
`revision`, `updatedAt`, `invitations` and `memberships`. Every child record repeats
the same tenant and organisation IDs. Composite scope is required for every
command and active-membership lookup; local IDs may occur in different tenants
without colliding. Identifiers are opaque, case-sensitive and never reused
within their record collection, even after expiry or removal.

`applyMembershipCommand(state, tenantAggregate, command)` accepts:

```js
{
    tenantId: 'internal-tenant-id',
    organisationId: 'internal-organisation-id',
    expectedRevision: 0,
    actorSubjectKey: 'immutable-lower-case-entra-tid:oid',
    now: '2026-09-05T00:00:00.000Z',
    action: 'invite',
    payload: {
        invitationId: 'new-invitation-id',
        subjectKey: 'resolved-invitee-entra-tid:oid',
        roles: ['viewer'],
        validFrom: '2026-09-05T00:00:00.000Z',
        validUntil: '2027-09-05T00:00:00.000Z',
        grantEvidenceId: 'approved-grant-reference',
        expiresAt: '2026-09-07T00:00:00.000Z'
    }
}
```

The illustrative subject strings above must be replaced with actual canonical
UUID pairs in a trusted integration; they are not accepted identity values.
Every input timestamp is explicit canonical UTC with milliseconds. The module
does not read the clock. A command or lookup earlier than aggregate `updatedAt`
fails, preventing a caller from rewinding state time to revive an expired grant.

| Action | Payload | Result |
| --- | --- | --- |
| `invite` | invitation ID, subject, roles, validity, grant evidence, invitation expiry | New pending invitation; expired pending history is retained and marked expired |
| `accept` | invitation ID, new membership ID | Nominated actor alone creates active membership using the invitation's unchanged grant |
| `revoke` | invitation ID | Unexpired pending invitation becomes terminal revoked |
| `suspend` | membership ID | Active membership becomes suspended |
| `resume` | membership ID | Suspended, unexpired membership becomes active |
| `remove` | membership ID | Active or suspended membership becomes terminal removed |

Invitation status is `pending`, `accepted`, `revoked` or `expired`. Membership
status is `active`, `suspended` or `removed`. Accepted/revoked/expired invitations
cannot be accepted again, and removed memberships cannot be resumed. Removal
retains history; it is not permanent deletion.

Roles are the finite target role names `admin`, `editor`, `viewer` and
`fractional_advisor`. They are grant metadata only; POR-007 defines permission
resolution. Grants require a non-empty, duplicate-free role list, an explicit
finite validity period and a safe reference to approval evidence. No arbitrary
permissions, provider mappings, email or raw evidence can be embedded.

The invitation expiry must be after its creation and no later than the grant
end. Acceptance must occur strictly before both.
Revocation at or after invitation expiry fails without mutation, preserving the
expired lifecycle meaning instead of relabelling history as administrator-revoked.
Canonical rehydration also rejects a revoked record timestamped at/after expiry.
Grant validity is half-open:
`validFrom <= now < validUntil`. Acceptance before `validFrom` records the
relationship but active lookup remains unavailable until the start time.

`resolveActiveMembership(state, tenantAggregate, { tenantId, organisationId,
subjectKey }, now)` returns a record only for an active, currently valid
membership in an active tenant and organisation. It returns no `allowed` flag
and must not replace independent authentication, RBAC, entitlement or provider
binding decisions. Suspended/closed ownership records deny creation, invite,
accept, resume and active lookup. Revocation, suspension and removal remain
possible for a trusted administrator so inactive ownership does not prevent
revoking a relationship.

## Duplicates, concurrency and history

A subject may have at most one unexpired pending invitation and at most one
non-removed membership in an organisation. A second invitation for an active or
suspended member is rejected. After expiry or removal, a new invitation needs a
new ID; subsequent membership acceptance also needs a fresh membership ID.
Historical invitations and memberships remain linked to their exact grant.

Every successful command increments the aggregate revision exactly once.
Missing, stale, future or exhausted revisions fail without mutation. A replayed
acceptance fails without creating another membership. This is fail-closed replay
handling, not a transparent idempotency receipt protocol: callers must reconcile
the stored result after an uncertain write and must not silently refresh the
revision and replay the original intent.

The future repository must atomically compare and swap the revision and write
the invitation and membership together. It must also keep the referenced tenant
and organisation eligibility coherent with the write. Pure in-memory validation
does not prove durable storage concurrency, forced RLS or live revocation latency.
The test-only repository adapter demonstrates two writers reading one revision:
exactly one acceptance can commit and the losing write changes nothing.

## Validation and migration effect

Canonical rehydration rejects missing or undefined fields, unknown properties,
accessors, inherited object shapes, symbols, sparse/custom arrays, malformed
identifiers/subjects/times, inconsistent grant links and cross-tenant children.
Errors contain stable codes, not principal IDs or raw evidence. Wrong scope,
missing membership and wrong accepting subject use the same not-found code.
Arrays are bounded to 10,000 records and history is not automatically pruned.
A later persistence design must define retention and capacity without deleting
grant history implicitly.

POR-003 adds no runtime imports, routes, email delivery, authentication changes,
configuration, SQL migration, Blob mutation, provider integration or deployment.
Existing Blob authority and provider-bound portal admission remain in force.
PostgreSQL/RLS persistence, mapping existing access to new records, delivery,
customer onboarding, entitlement gating and production activation require their
own governed integration and release evidence. Initial external customer
admission remains subject to SEC-002/RG-010 and fresh exact approval.

## Verification and recovery

Run `node --test test/membershipDomain.test.js` for dependency-free contract
tests, or `npm test -- --runInBand test/membershipDomain.test.js` in the installed
repository. The test file uses Node assertions and works with both runners.
Run `npm run verify` and `npm run eval:prospect:promptfoo` for the final build
lane. No dependency graph changed, so reuse the protected-main audit baseline.

Recovery is a reviewed revert of this additive source/test/documentation change.
No production setting, customer data, credential or migration must be reversed.
