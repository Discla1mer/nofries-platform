# Dashboard admission: provider-independent source service

POR-005 provides an authenticated, read-only dashboard admission and display
service for trusted server composition. A synthetic dashboard member can obtain
the existing dashboard renderer and their permitted modules without Autotask
company/contact identifiers or any provider call. The implementation is **source
only and uninstalled**: `/portal`, production factories, runtime flags, customer
admission and existing managed-service provider guards have not changed.

## Trusted adapter contract

`createDashboardService(adapters)` in `api/shared/dashboardService.js` requires
all four callbacks below. It has no implicit environment or production defaults.

| Callback | Required result and responsibility |
| --- | --- |
| `authenticate(request)` | Verify the current server session and return exactly `{ authenticated: true, subjectKey }`. `subjectKey` is the canonical lower-case immutable identity-tenant UUID and user-object UUID joined with `:`. Never derive authority from email, client headers/body, display labels or a previous projection. |
| `resolveScope(request, identity)` | Select exactly `{ tenantId, organisationId }`. Selection may express the requested organisation but cannot grant membership. The service independently validates ownership and active membership for the authenticated subject. |
| `loadSnapshot(scope, identity)` | Load one current, coherent, server-owned plain-data snapshot containing exactly `tenantAggregate`, `membershipState`, `entitlementState`, `flags`, `advisorAssignments` and `summary`. Use the existing domain schemas. Return `summary: null` when there are no figures and `advisorAssignments: {}` when no relevant grants exist. |
| `clock()` | Return a canonical UTC ISO timestamp with milliseconds, sampled after snapshot I/O. The existing domain validators reject non-canonical or regressing time and exclusive expiry boundaries. |

The snapshot loader must enforce one coherent read across tenant status,
organisation status, membership, product grants, flags, relevant assignments and
summary provenance. It must not combine independently cached revision histories,
truncate an organisation-wide assignment list or treat request JSON as stored
state. `advisorAssignments` is keyed by canonical module key and contains the
current relevant assignment for that member/module, or omits the key. Permission
policy validates its subject, membership, exact tenant/organisation, module,
permission, state, revision timestamp and validity window. A dashboard grant never
creates advisor authority or service operational readiness.

Advisor-derived access also requires a current purchased `fractional_advisory`
service with `service:fractional_advisory` explicitly enabled. The existing
entitlement resolver validates the purchase owner, status and validity window;
its service `enabled` result intersects that purchase with the flag. A role,
assignment or evidence reference cannot substitute for the purchase. Both
admission and display projection apply this condition to the actual permission
result: independently sufficient admin, editor or viewer permissions remain
valid without advisory purchase, including for a member who also has an advisor
role. A viewer with an unpaid Cyber advisor assignment receives only viewer
modules and no Cyber summaries.

`createDashboardAdmission(adapters)` in `api/shared/dashboardAdmission.js` returns
`admitDashboard(request, moduleKey = null)`. Every call authenticates and reloads
the current snapshot. The snapshot is detached and frozen without executing
accessors. Admission requires an active tenant, organisation and membership, a
current explicit dashboard product, the dashboard flag and at least one eligible,
role-permitted module. An explicit module read requires that exact module's
eligibility and registry-mapped read permission. A module can remain visible as
disabled in navigation without allowing its resource read. Unknown identity,
foreign scope, malformed state, missing grants and loader failures share the
generic `dashboard_access_denied` response and reveal no account details.

The result remains the existing browser-safe projection. Its
`admissionGranted: false` and `providerAccessGranted: false` fields deliberately
stay false: the object contains display data and grants no reusable authority.
No raw identity, membership, agreement, quota or provider identifier is returned.

## Read-only source routes and asset composition

The returned service offers `handleRequest(request, route)`. The trusted host
passes the exact relative route after its own bounded routing; URL parsing,
canonicalisation and session handling do not belong to request JSON.

| Exact relative route | Response |
| --- | --- |
| `bootstrap` | Complete current renderer-compatible projection. |
| `modules/<canonical_module_key>` | That module's permitted display state. Overview can include its filtered attention/metrics; Services can include non-operational service states. Other workspaces remain honestly `planned`. |
| `app.js` | Protected bundle containing the real dashboard registry followed by the renderer. |
| `dashboard.css` | Protected dashboard stylesheet, now included in the App Service package. |

Only exact `GET` is supported. Writes return 405; unrecognised paths, encoded
alternatives, record IDs and provider endpoints return 404. Every protected route,
including the script and stylesheet, requires a fresh admission check. Responses
use the existing private/no-store, same-origin resource, no-sniff and no-index
headers. No CORS access is added. Failure returns no partial protected content.

Module views are display resources, not APIs for underlying assessment/evidence
records. Record reads, draft reports, uploads, membership changes and service
actions must perform their own exact resource/action permission checks and
transactional revision binding. A previous bootstrap or successful module read
cannot authorise a later operation. The service intentionally provides no write,
provider, purchase, AI execution or activation endpoint.

## Architecture and path to an internal live journey

Keep the same-origin Express modular monolith. Its existing deterministic domain
modules already separate tenant/organisation ownership, membership, dashboard
product eligibility, role permission and optional service entitlements. The new
dashboard bootstrap composes those domains directly; the legacy managed-service
bootstrap continues to enforce its provider bindings. Splitting the application
into microservices would add coordination and operation cost before the current
user journey and persistence are complete.

The source shell, provider-independent admission adapter and current framework
components are synthetic/source-only capabilities. Before production composition,
DATA-001 must supply durable coherent dashboard snapshots and verified tenant
isolation; this change includes no schema, database adapter, migration or forced
RLS implementation. POR-008 supplies the audit integration. POR-006 independently
guards provider routes; POR-010 supplies governed onboarding and must not infer
provider readiness from buying a dashboard product.

The useful next vertical journey is an authorised internal organisation opening
the first NCSC assessment, recording improvement ownership and evidence, and
producing a correctly scoped report. Each read and write must bind to its exact
tenant, organisation, current role, entitlement and record scope. Identity
composition, organisation selection, request limits, rate limiting, audit
correlation, durable snapshot consistency, server route registration and the
fresh/expired-session browser loader still require an integrated implementation
and review. No placeholder adapter should be installed in their place.

After the internal journey works, freeze a coherent release candidate and run the
applicable SEC-002 first-customer security, tenant-isolation, dependency, privacy,
recovery and release gates. Verify cumulative deployment impact and exact SHA,
recovery and live readback. External-customer admission, customer data/credentials
and unrestricted uploads remain off until the corresponding gates and exact
authority are satisfied. Completing this source slice does not authorise live
admission or deployment.

## Verification and limitations

From the repository root:

    node --test test/dashboardAdmission.test.js test/dashboardService.test.js test/dashboardPackaging.test.js
    npm test -- --runInBand test/dashboardAdmission.test.js test/dashboardService.test.js test/customerPortalTickets.test.js test/customerPortalLifecycleBinding.test.js test/dashboardShell.test.js test/dashboardPackaging.test.js
    node scripts/build-app-service.js

Tests exercise provider-free admission, all four dashboard roles, exact module
scope, foreign tenant/organisation/subject denial, disabled and unpurchased
modules, current product and advisor revocation, membership removal, expiry during
loading, immutable snapshot capture, generic loader failure, protected assets,
real renderer composition and preserved legacy provider requirements. All data
is synthetic; the test harness is never imported by production code.

Advisor tests separately cover missing/disabled/suspended/revoked/future/expired
service purchases, foreign ownership, unrelated services, post-I/O expiry,
fresh protected-route revocation, independent normal roles and mixed-role
projection filtering. Valid advisor examples explicitly request the synthetic
advisory service; the shared fixture's advisor role alone still buys nothing.

Real-browser layout, keyboard/screen-reader use, durable concurrency behaviour,
production session integration and live customer journeys are not established by
these source tests. Root's combined source review and hosted CI record the final
head evidence. A packaged stylesheet is necessary for later activation but
creates no new route by itself.

## Company and consultant signup (29 September2026)

The public signup now begins with Company or Consultant. Any syntactically valid email may be verified; neither provider type nor name/domain resemblance is an admission requirement. The cookie-bound proof stores accountType, which must agree with the separately approved invitation and authority. Missing historical fields mean company without rewriting old records. The public choice is not a staff role or proof of client membership.

After genuine sign-in, applicable consent and current activation, the server projects only company or consultant as a destination discriminator. Company completion opens /dashboard; consultant completion opens /dashboard#organisations. The consultant portfolio uses the existing immutable-subject SQL binding directory. Each client selection still validates its current binding, membership, authority, generation and tenant scope. Company accounts retain the approved single-binding restriction. Operator and fractional-advisor privileges remain separate.

This is a source implementation, not evidence of live signup. Automatic first-organisation creation and consultant new-client creation remain incomplete. The current runtime has Reader access to the independent authority store and the existing activation controller requires explicit finite entitlements, role evidence, terms/schedule and exact approved publication authority for each organisation (docs/customer-activation.md). No reusable self-service admission policy or customer-scoped creation endpoint is installed. An approved reusable policy, canonical idempotent creation operation and deployment are required before promising that mailbox verification alone creates usable client organisations. Do not replace this gap with a browser-only portfolio, admin impersonation, arbitrary allowances, or direct writes to the authority container.
