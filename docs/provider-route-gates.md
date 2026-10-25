# Provider route entitlement and binding gates

POR-006 adds an **uninstalled source guard** for provider-backed read routes.
Current service entitlement and a valid organisation-bound provider binding must
both pass. Provider-free dashboard admission remains unchanged. No production
route, provider factory, customer admission, credential, licence or external
action is enabled by this change.

`createProviderRouteGuard(adapters)` in
`api/shared/appLifecycle/providerRouteGate.js` returns
`requireProviderRoute(request, routeKey)`. Each invocation authenticates and reads
current state again. Only exact `GET` and these closed, server-owned route keys
are accepted; request fields cannot choose the service, permission or provider:

| Source route key | Required service | Provider | Binding record type |
| --- | --- | --- | --- |
| `autotask/tickets` | `tier1_support` | `autotask` | `account` |
| `datto_rmm/devices` | `managed_endpoint` | `datto_rmm` | `site` |
| `kaseya_mdr/alerts` | `endpoint_security` | `kaseya_mdr` | `tenant` or `organisation` |

These are guard policy keys, not newly registered HTTP endpoints. Writes,
individual record paths, encoded alternatives and unknown providers are denied.
Adding another provider-backed route requires its own explicit policy and tests;
there is no fallback or wildcard gate.

## Required trusted adapters

| Adapter | Contract |
| --- | --- |
| `authenticate(request)` | Verify the current server session; return exactly `{ authenticated: true, subjectKey }` using the existing immutable lower-case identity-tenant UUID and user-object UUID. |
| `resolveTarget(request, identity, routeKey)` | Return exactly `{ tenantId, organisationId, targetId }`. Resolve an internal provider container/coverage target; never substitute a caller's external provider identifier. This selection does not itself establish membership. |
| `loadSnapshot(target, identity, routeKey)` | Return one coherent, current, plain-data snapshot with exactly `tenantAggregate`, `membershipState`, `entitlementState`, `flags`, `advisorAssignment`, `providerPolicy` and `binding`. Use `advisorAssignment: null` for an ordinary role. Return `binding: null` for missing or ambiguous current bindings. Never pick an arbitrary entry from historical or truncated results. |
| `clock()` | Return canonical UTC ISO time with milliseconds, sampled after snapshot I/O. |
| `auditDenial(event)` | Awaitably append the sanitised internal denial event. This is required even for identity, snapshot and provider-policy failures. Do not log the request, exception, credentials or provider response. |

Adapters belong to server composition and have no environment defaults. Authority
must not come from client headers/body, email, display labels, a browser
projection, a stale snapshot or a previously returned decision. The loader must
read tenant/organisation status, membership, relevant advisor assignment, service
grants, feature flags, provider policy and the unique current binding coherently.
Revoked bindings cannot be replaced with earlier verified revisions. Enforce
cross-organisation provider-record uniqueness in durable storage; the gate cannot
detect an unseen conflicting binding in another organisation.

The immutable snapshot is detached before policy evaluation without invoking
accessors. Sparse arrays, unexpected fields, malformed dates and non-data
objects are denied. The guard reuses `resolvePortalPermission` for current
membership and `services.read`; `assertServiceEntitlement` checks one current
explicit purchased grant for this service, `services` module, exact internal
target and `view` action, with its service flag enabled. A package parent or
dashboard product cannot supply missing service scope. An independently
purchased service does not require a dashboard product.

When the resolved `services.read` permission comes from `fractional_advisor`,
the same current snapshot must also contain an active, enabled
`fractional_advisory` purchase. A scoped advisor assignment does not supply that
purchase, and the provider route's service purchase does not replace it. Advisory
grant ownership, active dates and `service:fractional_advisory` are evaluated at
the same time sampled after snapshot I/O. Missing, revoked, suspended, expired,
future or disabled advisory service denies with `entitlement_denied`.

The additional requirement follows the role that actually supplied permission.
An independently granted admin, editor or viewer retains its own `services.read`
permission even if the membership also lists an advisor role with no advisory
purchase or a revoked assignment. Both paths still require the route-specific
service, exact target/action and binding. Advisory eligibility does not invent
provider target coverage for the advisory service or require a dashboard product.
Branded request context establishes only trusted identity and selection; it
cannot replace any current purchase, assignment or binding check.

## Current binding projection and freshness

`normaliseProviderBinding` accepts exactly these fields, with no implicit grants:

    schemaVersion, bindingId, tenantId, organisationId, targetId,
    system, recordType, providerScopeId, externalId, status,
    verifiedAt, validUntil, verificationEvidenceId, revision, updatedAt

`schemaVersion` is `1`; status is `verified`, `suspended` or `revoked`. Timestamps
are canonical UTC ISO strings. Revisions are non-negative safe integers. A
verified binding must include a non-empty verification evidence reference and
external record identifier. `verifiedAt <= updatedAt` and
`verifiedAt < validUntil` are mandatory. Existing lifecycle `externalReferences`
use the same system/record conventions but must be deliberately projected;
passing a legacy reference does not activate a dashboard binding.

The canonical Autotask record type is `account`, as persisted by
`lifecycleService.resolveServiceDeskProviderBinding` and the singleton slots in
`postgresLifecycleRepository.js`; the provider's company terminology does not
change that stored type. `company` is rejected, not silently aliased. Datto RMM
uses `site`; Kaseya MDR uses `tenant` or `organisation`, matching those same
existing singleton slots. A trusted future loader must deliberately combine the
current verified persisted reference with organisation/target ownership, current
revision and freshness policy to produce this projection. No migration or
legacy-state authorisation shortcut is introduced.

The independent server-owned provider policy has exactly `system`,
`providerScopeId`, `revision`, `maxBindingAgeMs` and `updatedAt`.
`maxBindingAgeMs` is an explicit positive safe integer; the guard does not invent
a supplier freshness policy. The account must be the configured account for this
provider, not a value copied from the binding to make it pass.

The gate requires the binding's tenant, organisation, internal target, provider,
record type and provider account to match the current request and policy. Only
`verified` passes. Neither policy nor binding can be updated in the future.
The verification timestamp must be at or before evaluation, and age must be
strictly less than `maxBindingAgeMs`; `validUntil` is also exclusive. Missing,
ambiguous, stale, revoked, suspended, foreign or malformed bindings deny.

## Denial audit and customer privacy

Every runtime denial awaits one frozen event containing:

    schemaVersion: 1
    eventType: "provider_route.denied"
    policyVersion: 1
    routeKey: <known policy key or null>
    reason: <closed evaluation stage>
    evaluatedAt: <valid policy evaluation time or null>
    actorSubjectKey: <verified immutable subject or null>
    selectedTarget: <immutable internal tenant/organisation/target or null>
    scopeAuthorised: <true only after current portal permission passes>

Reasons are `request_invalid`, `identity_denied`, `selection_denied`,
`snapshot_unavailable`, `permission_denied`, `entitlement_denied` and
`binding_denied`. This is an internal audit handoff, never a customer response.
Selected scope is explicitly distinguished from membership-authorised scope.
`scopeAuthorised` means tenant/organisation `services.read` permission passed;
it does not assert target entitlement, provider binding or executor authority.
Concurrent requests retain their own immutable actor/target context. No external
provider ID, provider account, binding ID, raw exception, request body or secret
enters the event. The durable adapter adds its own trusted receipt timestamp and
correlation metadata; do not manufacture successful audit evidence when storage
fails. Audit failure preserves denial and must be monitored by that adapter.

Every customer-facing error is `provider_route_access_denied` with status 403 and
only that generic code in `details`. Audit failures do not reveal an underlying
storage message and do not permit a provider operation.

## Meaning of a successful result

The frozen result is **server-only diagnostic context** containing the internal
target, subject, route, service, relevant revisions and exact provider reference.
`preconditionsSatisfied: true` means this snapshot passed this source gate.
`providerAccessGranted: false` is deliberate. Do not serialise this result to the
browser, cache it as authority or accept it on a later request. The existing
dashboard projection still contains no binding, provider account or external ID.

Before a real provider read, the host must additionally enforce the existing
provider-specific record visibility, covered device/target mapping, contact and
company restrictions, service assignment, licence and adapter readiness, and
current operation fences. `services.read` permits service visibility for normal
dashboard roles; it never grants unrestricted ticket, device or alert visibility,
credentials, provider operator privileges or vendor writes. The gate performs no
provider call and does not replace those controls. Current revisions must be
revalidated/fenced at actual use; a gap between policy evaluation and execution
cannot be bridged by treating this diagnostic object as a token.

## Acceptance evidence and remaining integration

From the repository root:

    node --test test/providerRouteGate.test.js
    npm test -- --runInBand test/providerRouteGate.test.js test/entitlementDomain.test.js test/portalPermissions.test.js test/customerPortalLifecycleBinding.test.js test/dashboardAdmission.test.js test/dashboardService.test.js
    node --check api/shared/appLifecycle/providerRouteGate.js

Synthetic tests exercise every provider's entitlement/binding conjunction,
exact target/account/type scope, missing/stale/revoked bindings, revocation and
membership changes between calls, expiry during I/O, current advisor permission,
generic failure, audit wait/failure/concurrency, immutable snapshot capture and
continued provider-free dashboard routes. No test uses provider credentials or
asserts live enforcement.

Advisor regressions require both purchases, deny invalid advisory states even
with a valid route service/binding, detect advisory revocation and expiry after
I/O, preserve independently granted normal roles, and prove that a real branded
tenant request context cannot authorise an unpaid advisor. Denial attribution
keeps its existing meaning: `scopeAuthorised` records portal permission only,
while advisory service denial remains in the `entitlement_denied` stage.

DATA-001 must supply coherent durable snapshots, current binding uniqueness and
transactional revision fencing. POR-008 must persist and monitor denial audits.
Server registration, session integration, provider-specific downstream controls,
real provider evidence and the applicable first-customer/release gates remain
separate work. Source acceptance of POR-006 is not proof that production routes
already run this gate or that a customer can use provider-backed services.
