# Dashboard entitlement contract (POR-004)

## Status and boundary

This is a source-only, server-side contract for the approved PROD-001 product
basis. It introduces no HTTP route, persistence adapter, customer admission,
provider integration, pricing, billing, licence purchase or production setting.
Existing `api/shared/customerPortalAccess.js`, customer masters and managed-service
Monthly Proof mapping are unchanged. A resolver result is **eligibility, not
permission to enter the portal or execute a provider action**.

The implementation is `api/shared/appLifecycle/entitlementDomain.js`. Its only
runtime dependency is the existing `tenantDomain.js`. The retained connector's
`api/shared/lifecycle` tree and all package/lock files are unchanged.

## Three independent questions

An agreement-backed entitlement answers what was purchased for a specific
organisation. Server-owned feature flags and an exact profile-version activation
registry answer what is implemented and available. Authentication, membership,
RBAC, provider bindings, covered targets and action authority answer whether this
principal may perform the particular operation. None substitutes for another.

Missing flags are disabled. Missing grants or finite quantities do not default
to a free plan, an unlimited allowance, a role or a provider connection. No
Autotask, RMM, MDR or other provider ID is needed to resolve dashboard eligibility.

## Canonical records

Every snapshot explicitly includes schemaVersion 1, tenantId, organisationId,
a non-negative safe-integer revision and a dense grants array. Each grant also
carries tenantId and organisationId; a foreign child inside a valid aggregate
is rejected. Rehydration has no implicit active status or revision defaults.

Every grant has these fields, with no unrecognised fields:

| Field | Meaning |
| --- | --- |
| tenantId, organisationId | Exact opaque internal owner, matching the snapshot and canonical tenant aggregate |
| grantId | Immutable, organisation-local grant identity; never reused for a new term |
| code | A recognised canonical product or service key |
| status | active, suspended or revoked |
| validFrom, validUntil | Explicit finite term: inclusive start, exclusive end |
| agreementRef | Safe opaque reference to the sealed agreement/schedule, not its sensitive contents |
| modules | Explicit dashboard module scope; not a wildcard |
| frameworks | Exact moduleId/profileId/version tuples for ordered assessment modules |
| limits | Explicit finite integer quantities; absent keys deny consumption |
| coverage, actions | Explicit service target/action scope; empty for a dashboard product |

Timestamps use canonical UTC `YYYY-MM-DDTHH:mm:ss.sssZ`. Invalid dates, sparse
arrays, accessors, unknown keys, duplicate IDs/tuples, wildcard identifiers and
unsafe quantities fail closed. Snapshots and decisions are deeply immutable.
Record counts do not impose an implicit customer or fleet-size limit. The trusted
repository must bound transport and processing through coherent pagination or a
complete relevant snapshot at one revision. Never truncate grants, coverage or
profile activation to a first page: later records can change eligibility or make
a service grant ambiguous. Enforce request-size limits before accepting untrusted
input, not as a hidden purchased-capacity limit in this server-owned contract.
Product overlap validation sorts finite terms and checks adjacent intervals, so
retained term history does not introduce quadratic overlap validation.

## Product and module matrix

`dashboard_score` supports explicitly ordered Overview, Cyber Security,
Improvement Plan, Evidence, Board Reports and Services. `dashboard_govern` adds
AI Governance and IT Optimisation as possible ordered modules. Govern does not
automatically enable any module or buy advisory, support or managed IT.

The module IDs are `overview`, `cyber_security`, `ai_governance`,
`it_optimisation`, `improvement_plan`, `evidence`, `board_reports` and `services`.
An assessment module also needs at least one ordered exact profile version.
A profile is eligible only when that same tuple is present in the server-owned
activation registry. Enabling a module cannot silently enable a new, unlicensed
or unimplemented profile version.

Active product terms cannot overlap, even when both are Score or both are Govern,
or the overlap is in the future. A switch at the exact boundary selects the new
grant's explicit scope and limits; it never merges the old and new tiers.
The Govern workflow additionally requires ordered/enabled Improvement Plan and
`governance_workflow=true`. Score never obtains it from a flag alone.

`resolveEntitlements(state, aggregate, selector, now, flags)` returns the selected
product, explicit module eligibility/reasons, eligible profile tuples, service
purchase/readiness distinctions and source revisions. It always returns
`admissionGranted=false` and `providerAccessGranted=false`. This projection is
intended for POR-009's truthful module navigation and disabled states.

## Feature configuration

A supplied flags record contains tenantId, organisationId, revision, enabled
and frameworks. Each key under enabled must be recognised and boolean. Accepted
keys are `dashboard`, each module ID, `governance_workflow`, `ai_drafting` and
`service:<canonical service code>`. frameworks is a dense array of the exact
moduleId/profileId/version tuples independently approved for availability.
Omitting the entire record disables features; a malformed or wrong-tenant record
is an error, never an enablement fallback. Configuration is loaded by the server,
not accepted from the browser or inferred from a paid tier.

## Services are not product or role shortcuts

Canonical service codes are fractional_advisory, tier1_support, managed_endpoint,
endpoint_security, work_file_backup, microsoft_365_admin, google_workspace_admin,
supplier_coordination, monthly_proof, customer_onboarding, ai_service_desk and
managed_it_core. Their quantities, target scope and actions must come from the
actual agreement; there is no automatic package expansion.

managed_it_core accepts only non-authorising package metadata: empty modules,
frameworks, limits, coverage and actions. Its presence authorises no child.
fractional_advisory requires a separate scoped/time-bound advisor assignment.
tier1_support is a human-service purchase, not ai_service_desk or a 24/7 promise.
A self-service Board Report is not issuer-approved managed-service Monthly Proof.

`assertServiceEntitlement(state, aggregate, request, now, flags)` requires one
unambiguous active, enabled grant matching exact module, target and action. It
returns the agreement/grant reference and remaining provider/assignment boundary,
not operational authority. An absent, expired, ambiguous or wrong-scope service
fails. Provider readiness is always false in this layer; POR-006 must independently
verify binding, covered target, enabled adapter, licence and action authority.

## Finite limits and concurrency

The limit keys are assessment_runs, report_exports, evidence_bytes, memberships
and ai_requests. Quantities in tests are synthetic examples, not prices or standard
customer allowances. Units are explicit whole counts/bytes. All counters are
bound to one immutable product grant and its finite term; there is no clock-based
counter reset, implicit renewal, refund or decrease operation in this contract.
Where a signed allowance has a different period, the integration must model that
period explicitly before activation; it must not reinterpret a term counter.

`consumeEntitlementLimit(state, aggregate, usage, command, now, flags)` enforces
positive finite quantities, module scope, exact assessment profile when relevant,
active ownership/product, explicit limit, available balance and matching revisions.
AI additionally needs ai_drafting enabled; deterministic assessment operations do
not depend on that flag. This is an AI request allowance only, not permission to
spend or proof of the separate NZ$15/tenant/month cost ceiling.

Usage carries schemaVersion, owner, grantId, revision and counters. A missing
counter is an error, not zero. The command carries owner/grantId, expected
entitlement/flag/usage revisions, moduleId, limit, amount and framework (an exact
profileId/version for assessments, otherwise null). The result increments the
usage revision once and changes only the named counter. All inputs remain intact
on failure, including overflow or an exhausted revision.

**Durable atomic enforcement is an integration gate, not a claim of this PR.**
The future repository must read trusted state and atomically compare entitlement,
feature configuration, ownership/membership and usage revisions before committing
the counter and consequential operation. Two independently calculated candidate
snapshots are not two successful reservations. The contract test demonstrates
one winner under a compare-and-swap store; it does not prove PostgreSQL/RLS.
Store an operation receipt/idempotency key with the transaction. Reconcile an
ambiguous commit before retry; do not obtain a fresh revision and consume again
blindly. Refund/release/current-allocation counters need a separately reviewed
operation before live use, rather than manually decrementing usage.

## Migration and integration gates

No legacy record is rewritten, silently accepted or automatically promoted. A
future server-owned migration must read the sealed schedule, verify owner and
actual covered quantities, choose a canonical key, create an immutable bounded
grant and reconcile the old/new records before activation. Suggested compatibility
mappings for that explicit review are datto_rmm to managed_endpoint, mdr to
endpoint_security, and endpoint_backup/backup to work_file_backup. This resolver
rejects aliases, duplicate preferred/alias emissions and the non-sellable internal
pilot key. Existing legacy readers retain their current behaviour in this PR.

Before any active customer issue, independently prove the migration, canonical
activation projection and any affected Monthly Proof mapping. Do not pass new
product/advisory/support keys into an unchanged legacy customer-master parser.

POR-005 connects authenticated membership to this eligibility contract. POR-006
owns provider enforcement. POR-007/008 supply role/tenant/audit integration.
POR-009 supplies the responsive shell. POR-010 and SEC-002/RG-010 retain controlled
onboarding and first-customer admission. PostgreSQL/RLS and durable quota
transactions remain prerequisites for the applicable live capability, not blockers
to this isolated source implementation. No external customer is enabled here.

## Verification

From the repository root:

    node --check api/shared/appLifecycle/entitlementDomain.js
    node --test test/entitlementDomain.test.js

The same file runs in the existing Jest suite without new dependencies. Required
hosted checks and independent changed-scope review must pass before merge. A local
pass is not a deployment, live authorisation test, billing proof or database proof.
