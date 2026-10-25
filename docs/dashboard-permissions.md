# Dashboard roles and scoped advisor permissions

Status: POR-007 server-side source contract, not installed on production routes.

`api/shared/appLifecycle/portalPermissions.js` checks the permission for one
operation in one organisation and module. It consumes current POR-002 ownership
and POR-003 membership state, with explicit trusted time. No provider identifier
is needed. A role is not a purchased service, product entitlement or runtime
feature flag, and none of those is proof of a role.

## Permission matrix

These roles belong to organisation memberships. They are separate from existing
No Fries operator roles in `tenantAccess.js`; no existing `admin`, `customer_admin`,
`consultant` or `service_owner` principal is automatically migrated or admitted.

| Permission | Module | Admin | Editor | Viewer | Assigned advisor maximum |
| --- | --- | --- | --- | --- | --- |
| `overview.read` | Overview | Yes | Yes | Yes | Explicit grant |
| `assessment.read`, `assessment.write` | Cyber Security, AI Governance or IT Optimisation | Yes | Yes | No | Explicit module and permission grant |
| `improvement.read`, `improvement.write` | Improvement Plan | Yes | Yes | No | Explicit grant |
| `decision.read`, `decision.write` | Improvement Plan | Yes | Yes | No | Explicit grant |
| `decision.approve` | Improvement Plan | Yes | No | No | No |
| `evidence.read`, `evidence.link` | Evidence | Yes | Yes | No | Explicit grant |
| `evidence.review` | Evidence | Yes | No | No | Explicit grant |
| `report.read_issued` | Board Reports | Yes | Yes | Yes | Explicit grant |
| `report.read_draft`, `report.draft` | Board Reports | Yes | Yes | No | Explicit grant |
| `report.approve` | Board Reports | Yes | No | No | No |
| `services.read` | Services | Yes | Yes | Yes | Explicit grant |
| `membership.manage`, `advisor.manage` | Overview | Yes | No | No | No |

Canonical module IDs are `overview`, `cyber_security`, `ai_governance`,
`it_optimisation`, `improvement_plan`, `evidence`, `board_reports` and `services`.
Every permission is restricted to the listed module(s); unknown names, wildcards
and mismatched pairs deny. Permissions never make an unfinished module available.

A viewer consumes the overview, Services information and issued board reports.
It does not receive draft assessments, raw evidence or draft reports by default.
The resource service must select `report.read_draft` for a draft, and enforce
immutable issued status for `report.read_issued`; a permission check alone cannot
classify or filter a supplied resource. Overview and issued-report projections
must retain their own customer-safe data rules.

An editor can author assessment responses, improvement work, linked evidence,
decisions and report drafts. Only an admin has access-management and approval
permissions. Approval permission is only the role prerequisite: it does not
replace independent maker/checker/issuer rules or permit self-approval. Likewise
`evidence.link` does not enable unrestricted upload, retention change or deletion.
No permission grants billing, provider writes, service remediation, unrestricted
customer-data access or changes to deterministic scoring rules.

## Fractional advisor assignments

`fractional_advisor` grants nothing by itself. The trusted repository must supply
an explicit assignment to the same tenant, organisation, immutable subject and
membership ID. An assignment is a complete read-only projection:

```js
{
    schemaVersion: 1,
    assignmentId: 'advisory-scope-1',
    tenantId: 'tenant-a',
    organisationId: 'org-1',
    membershipId: 'member-1',
    subjectKey: '20000000-0000-4000-8000-000000000000:20000000-0000-4000-8000-000000000001',
    status: 'active',
    validFrom: '2026-09-05T01:00:00.000Z',
    validUntil: '2026-10-05T01:00:00.000Z',
    modules: ['cyber_security'],
    permissions: ['assessment.read', 'assessment.write'],
    grantEvidenceId: 'approved-engagement-1',
    revision: 0,
    updatedAt: '2026-09-05T01:00:00.000Z'
}
```

All values above are synthetic. `grantEvidenceId` is a safe reference, not raw
contract or customer content. Assignment creation, approval, revocation, audit
history and durable storage are integration work; this module writes nothing.
The assignment purchase and scope must be verified by the trusted service.
The separate active `fractional_advisory` entitlement is still required before
using advisor-granted access; it is not inferred from a role or evidence string.

Assignment status is explicitly `active` or `revoked`. Both membership and
assignment must be valid at `validFrom <= now < validUntil`; the assignment term
must fit entirely inside the membership term. A revoked, expired, future-dated,
foreign or replacement-membership assignment cannot grant permission. Membership
expiry, suspension or removal also denies regardless of assignment state.

Modules and permissions are explicit non-empty, duplicate-free finite lists.
Advisors can receive at most the editor set plus evidence review; no assignment
can grant management or approval permissions. Permission and module must occur
in the same assignment, so separate grants cannot be combined into a broader
cross-module grant. Other independently granted roles retain their own authority;
an admin who also has an advisor role is still an admin within that organisation.

The repository queries one relevant current assignment using the exact tenant,
organisation, subject, membership, permission, module and evaluation time. It
returns a complete candidate or null, rather than an organisation-wide array.
There is no fixed assignment or history count that limits dashboard access.
Normal-role permission checks never load or inspect advisor assignments.

The adapter must select from current authoritative assignment state, with a
unique assignment ID/current revision and deterministic selection when several
valid grants match. It must not filter old active revisions from an append-only
history: a later revocation supersedes those revisions. It may use an indexed
database query without materialising all current or historical assignments.
Selecting an arbitrary first page and treating it as the complete query is not
valid. This module does not implement that repository adapter.

For advisor-derived permission, malformed, foreign, revoked, future or expired
selected records deny. Validation rejects missing or unknown fields,
non-canonical identities/times, accessors, inherited objects, symbols,
custom/sparse module/permission arrays and unknown schema versions. No defaults
turn an incomplete saved record into a grant. Assignment-list input cannot be
combined or interpreted as a single grant.

## Server-side use

`resolvePortalPermission(membershipState, tenantAggregate, selector,
advisorAssignment, now)` is a deterministic snapshot policy. The assignment is
one canonical current candidate or null. The selector has
exactly `tenantId`, `organisationId`, `subjectKey`, `permission` and `module`.
It invokes POR-003 active membership resolution before applying the matrix.

`createPortalPermissionGuard(adapters)` returns an async
`requirePermission(request, { permission, module })` function. Required trusted
adapters are:

- `authenticate(request)` returns exactly `{ authenticated: true, subjectKey }`
  after verifying the actual session/token and canonical immutable identity.
- `resolveScope(request, principal)` returns the authorised server-derived
  `{ tenantId, organisationId }`; it must not trust a body field as authority.
- `loadTenantAggregate(scope)` and `loadMembershipState(scope)` return current
  authoritative scoped data.
- `loadAdvisorAssignment(query)` is used only when advisor authority is needed.
  Its exact query contains `tenantId`, `organisationId`, `subjectKey`,
  `membershipId`, `permission`, `module` and canonical timestamp `at`.
  It returns one current matching candidate or null using the rules above.
- `clock()` returns canonical UTC including milliseconds from the server clock.

The guard reloads ownership and membership on every invocation and samples time
after I/O. It resolves ordinary roles first; advisor-derived requests then load
the relevant assignment and sample time again before the final check, so expiry
during either read is honoured. Request-body roles, subject, approval,
entitlements and assignments are never consumed by the policy. An authentication
boolean copied from the request is not a valid adapter implementation.

Call the guard before the protected operation, using a server-owned permission
and resource-derived module. Do not accept the caller's requested permission as
the required operation permission. Then enforce the product/module entitlement,
feature availability, resource ownership, applicable advisor-service entitlement,
provider binding/coverage and independent approval rules. Do not wire this guard
to a route without those integration gates.

Success returns detached frozen evidence containing the policy version, scope,
subject, membership/revision, operation, role, assignment/revision and evaluation
time. This is not a bearer token, cache entry or durable authorisation receipt.
Keep identity evidence server-side; do not return it to the browser or log it
indiscriminately. Denials use only `portal_permission_denied` with status403, so
they disclose no tenant, identity, assignment or raw evidence.

Fresh reads prove revocation between requests. They do not prove transactionally
coherent reads or prevent revocation racing a mutation. A mutation adapter must
check the relevant membership, assignment and ownership revisions in the same
transaction/conditional write as the mutation, and re-authorise after conflict.
No Blob/SQL adapter, RLS, runtime role assignment or live revocation guarantee is
introduced by POR-007.

## Verification and recovery

Run `node --test test/portalPermissions.test.js test/membershipDomain.test.js` for
dependency-free tests, or the equivalent repository Jest invocation. Final
hosted CI runs the normal `npm run verify` and promptfoo mock gate. The package
graph is unchanged; reuse the protected-main dependency baseline.

Recovery is abandonment of the isolated source branch or a reviewed additive
revert. There are no customer records, credentials, provider actions, persistent
resources or deployment settings to reverse. Existing runtime portal access is
untouched. Real-customer admission remains separately governed by SEC-002/RG-010.
