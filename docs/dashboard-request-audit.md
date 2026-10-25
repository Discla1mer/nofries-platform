# Dashboard request context, audit and readiness

POR-008 adds **uninstalled source interfaces** for a trusted same-origin dashboard
host. It changes no route, session handling, permission, flag, provider adapter,
legacy health response, dependency, schema or customer admission. Synthetic tests
establish these interfaces; production composition and durable writes remain
DATA-001/POR-010 work.

## One context per protected request

`createTenantRequestContext(adapters)` in
`api/shared/appLifecycle/tenantRequestContext.js` returns `resolve(request)`,
`authenticate(request)` and `resolveScope(request, identity)`. Supply exactly:

| Adapter | Required trusted behaviour |
| --- | --- |
| `authenticate(request)` | Verify the server session and return exactly `{ authenticated: true, subjectKey }`; subject is the canonical lower-case identity-tenant UUID and immutable user-object UUID joined by `:`. |
| `resolveScope(request, identity)` | Select exactly `{ tenantId, organisationId }` using canonical dashboard IDs, never legacy provider keys. Selection alone grants no access. |
| `createRequestId()` | Generate a fresh server UUID, for example `crypto.randomUUID`; never copy request headers or user input. |
| `clock()` | Return current canonical UTC ISO time with milliseconds after identity/scope I/O. |

Create one resolver for a server composition and supply its `authenticate` and
`resolveScope` wrappers to `createDashboardAdmission`, `createDashboardService`
and `createPortalPermissionGuard`. Every protected handler participating in that
composition must share the same original HTTP request object and resolver. A new
HTTP request must have a fresh object; do not reuse it for jobs or later requests.
For the POR-006 provider guard, its trusted `resolveTarget` adapter must obtain
`context.resolve(request).scope` and select the target inside that exact scope;
the existing provider binding/permission checks must still run.

The first resolution installs a promise in a `WeakMap` before running adapters.
Parallel consumers and later consumers of that request receive the same frozen
identity and selection, or the same rejection. Client `body`, `headers`, context
properties and correlation values are never interpreted by this module. Scope
wrappers reject identities which differ from that request's authenticated subject.
No request body is retained in the context. A detached or cloned context fails
its process-local provenance check.

This caches identity and **selection only**. A context is not membership evidence,
permission, an entitlement, a bearer token or a tenant store query result. Existing
guards must still read current coherent state for each operation. Revocation
between checks on one request is covered by a real dashboard admission test. DATA-001
must bind consequential mutations to current tenant ownership and policy revisions
inside the transaction. The request resolver has no implicit timeout: host session
and scope adapters must already enforce bounded I/O and request cancellation.

## Closed audit envelopes and awaited delivery

`createDashboardAudit({ writeEvent, clock, createEventId })` in
`api/shared/appLifecycle/dashboardAudit.js` provides:

- `createEvent(context, { action, module, result })`: creates an immutable envelope
  from a process-branded context. Actions and modules use the existing permission
  vocabulary, including sensitive assessment, decision, evidence, membership and
  advisor mutations. Results are exactly `succeeded`, `denied` or `failed`.
- `writeEvent(event)`: awaits the trusted sink and returns only
  `{ eventId, delivery: 'acknowledged' }`. It accepts only an original envelope
  from that audit factory. On sink failure it throws the generic
  `dashboard_audit_unavailable` error without an exception body or credentials.

`clock()` has the same timestamp contract and cannot precede context resolution.
`createEventId()` must generate a fresh server UUID. Each envelope contains only
schema/type, event/request IDs, canonical actor subject, selected tenant and
organisation IDs, canonical action/module, result and time. Unknown metadata,
getters, raw error objects, payloads, headers, queries and provider IDs/responses
are rejected. The trusted identity/scope adapters must not place secrets in
canonical IDs. The tenant field denotes the **selected scope**, not proof that
membership or access succeeded. Unauthenticated failures have no branded tenant
context: use the host's separately redacted authentication-denial channel and do
not invent an actor or tenant from request claims.

Envelope creation makes no call, grants no permission and records no mutation.
An event's `succeeded` field is the trusted producer's proposed result; it is not
commit evidence. For a sensitive durable mutation, validate current authority,
create the success envelope and commit the mutation and envelope in the **same
DATA-001 transaction**. Only the transaction's own durable receipt can establish
that outcome. The explicit sink method is suitable for request/denial telemetry
or a separately designed durable event writer; a resolved callback alone cannot
prove atomic storage, delivery exactly once, rollback or application success.

For uncertain sink delivery, retry the **same immutable envelope/event ID** with
sink deduplication. Never rerun an application mutation because post-commit
telemetry failed. A failed transaction or unknown commit must use its own durable
recovery/idempotency protocol. This module deliberately has no mutation wrapper,
transaction implementation, cross-request deduplication store or live audit sink.
The sink must enforce access control, retention, bounded delivery and tenant
partitioning. Do not expose these envelopes to an unauthorised browser.

## Dashboard-only dependency observation

`createDashboardReadiness(adapters, timeoutMs = 1000)` in
`api/shared/appLifecycle/dashboardReadiness.js` requires exactly `identity`,
`snapshotStore`, `auditStore` probe callbacks and `clock`. Each probe receives
`{ cancellation }` and must return exactly `{ ready: boolean }` after checking its
relevant capability. No Autotask, RMM or MDR provider is required or consulted.
The audit store probe must establish the storage guarantees required by the host;
a process-local queue or callable function is not durable transaction readiness.

Probes run concurrently and each has a timeout between 1 and 5,000 ms. The returned
immutable observation contains only the capability, readiness, timestamp and
closed dependency states (`ready`, `unavailable`, `timed_out`). Malformed/extra
fields, failures and raw exceptions become `unavailable`; timeouts cancel the probe
and cannot become healthy through late resolution. An invalid clock produces
`ready: false` and `checkedAt: null`. Every call checks afresh; no cached health
can survive recovery or loss of a dependency.

The frozen cooperative token exposes `isCancelled()` and
`onCancel(listener)`, which returns an unsubscribe function. Timeout marks the
token cancelled, invokes subscribed cleanup callbacks directly, and contains both
thrown errors and returned Promise rejections. One failed cleanup does not prevent
other callbacks. A late subscription observes cancellation immediately; a probe
which already completed releases its listeners. No cleanup exception is logged.

This token is **not a native AbortSignal** and must not be passed to `fetch` or an
SDK's `signal` option. Native EventTarget abort listeners can rethrow outside the
probe's Promise chain, terminating the process. An adapter may translate the
token to a cancellation API only when it owns that API's error handling. Each
adapter must use bounded I/O and prompt cleanup; cancellation remains cooperative
and cannot preempt arbitrary adapter code. The host must rate-limit
checks and prevent unbounded overlapping probes when backends fail. This is an
operator observation, not a public endpoint, tenant authorisation, release gate
or admission decision. It intentionally leaves the existing `/api/health`
provider/runtime contract untouched. POR-010 must install a separately governed,
access-controlled dashboard health/telemetry integration.

## Evidence and remaining integration

Run from the repository root:

    node --test test/tenantRequestContext.test.js test/dashboardAudit.test.js test/dashboardReadiness.test.js
    npm run verify
    npm run eval:prospect:promptfoo

The 36 new tests exercise parallel context sharing, interleaved tenant isolation,
identity mismatch, cached denials and retry boundaries, current policy revocation,
immutable envelopes, forged/extra input rejection, awaited sink failures, stable
retry IDs, dependency isolation, timeout cancellation, recovery and redaction.
An isolated child-process regression proves throwing or asynchronously rejecting
cleanup callbacks neither terminate the process nor expose their error text;
the original native AbortSignal implementation fails that regression.
All data and adapters are synthetic. Existing protected source tests remain the
regression baseline; no package or lockfile changed.

The parent compares all base files against protected-main tree
`58dce7896956b725452884c71879399eb6d04be3` at
`bdbdb28324fdaa2943e1458f95e1c4de69b26ea7`, then records final exact-head hosted
checks and independent review in the PR and tracker. Local tests do not establish
production sessions, actual tenant database isolation, durable atomic mutation
auditing, browser behaviour or alert activation. DATA-001/POR-010 must compose
these primitives and SEC-002 must verify the first-customer security/recovery
and release gates before a live journey can be called complete.
