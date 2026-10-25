# Durable NCSC assessment API

NCSC-004 provides the API for the accepted NCSC Cyber Security assessment.
An authorised member can list, create, read, save and submit an assessment. The
PostgreSQL transaction retains every version, the original retry result and its
successful audit event. Submission also consumes the applicable finite quota in
that same transaction. The accepted evaluator and assessment domain are reused
without changing their profile, scoring or lifecycle rules.

The production application conditionally composes these routes at
`/api/dashboard/ncsc/assessments`. `lib/productionApplication.js` composes the
dashboard, and `lib/dashboardProduction.js` supplies the NCSC adapter only when
`NOFRIES_DASHBOARD_RUNTIME_ENABLED` and `NOFRIES_DASHBOARD_NCSC_ENABLED` are
`true`. `server.js` mounts `/api/dashboard`; `api/shared/dashboardRuntimeHandlers.js`
dispatches assessment requests with authenticated organisation selection, request
limits and browser mutation policy. Restricted PostgreSQL HTTP tests exercise
this composition with synthetic provider and Blob storage boundaries; see
[customer journey verification](customer-testing-smoke.md). Source composition
and those tests do not establish live repository selection, a production
migration, enabled customers or real customer acceptance.

An N/A response is a pending claim with rationale; it does not create an approval
or issue a report. Evidence/risk inputs begin as explicit retained placeholders;
there is no upload or evidence-edit endpoint in this slice.

## Trusted composition

Compose the existing DATA repository with explicit NCSC adapters:

```js
const repository = createPostgresDashboardRepository({
    database, clock, authoriseAdministration,
    ncsc: { audit, resolveSubmissionQuota }
});
const service = createNcscAssessmentService({ repository, requestContext });
const handlers = createNcscAssessmentHandlers({ service, guardMutation });
```

The imports are respectively
`api/shared/appLifecycle/postgresDashboardRepository.js`,
`api/shared/ncscAssessmentService.js` and
`api/shared/ncscAssessmentHandlers.js`. `database` is the existing PostgreSQL
transaction adapter over a restricted runtime pool. `clock` supplies exact UTC
ISO instants. `requestContext` is an existing `createTenantRequestContext`
instance with trusted authentication, canonical selection and request-ID
adapters. `audit` is an existing `createDashboardAudit` instance. No pool,
identity, service purchase, product grant or commercial policy is defaulted.

Omitting `ncsc` keeps its operations unavailable while existing DATA methods
remain usable. Partial configuration fails composition. The three added facade
methods accept branded context and strictly closed arguments:

```js
await repository.listNcscAssessments(context, { limit, afterAssessmentId });
await repository.readNcscAssessment(context, { assessmentId });
await repository.executeNcscAssessment(context, {
    assessmentId, action, idempotencyKey, expectedRevision, payload
});
```

Branded context proves identity/scope provenance. Each operation still loads
current authority under the tenant transaction fence. It requires an active
tenant, organisation and membership, the relevant `assessment.read` or
`assessment.write` permission, an eligible Cyber Security product and enabled
exact accepted profile/version. Access derived from `fractional_advisor` also
requires the current scoped assignment and purchased, enabled
`fractional_advisory` service. Independently granted ordinary roles retain their
permissions. These checks apply to original execution, reads and exact retry.
An earlier admission decision cannot authorise a later database operation.

The selected tenant and organisation must be exactly representable by the
assessment domain: `[A-Za-z0-9][A-Za-z0-9._:-]{0,119}`. A branded canonical
selection outside that domain fails `ncsc_selected_scope_unsupported` before
database access. No ID truncation, normalization or ownership mapping occurs.

`guardMutation(request)` is mandatory at handler composition. Before invoking a
mutation service, the handler awaits its result and requires literal `true`.
False, any other value, an exception or a rejected Promise yields the same
sanitized 403. Reads do not invoke this guard. The dashboard host checks mutations
with `assertExactSameOriginRequest` against the configured trusted production
origin before dispatch, then supplies a guard bound to that same immutable
request. The separate `assertSameOriginForMutation` helper permits explicit
headerless/development paths and compares host values, so it alone does not
establish exact same-origin policy for every configuration. This slice does not
modify that helper.

The handler captures a detached normalized mutation command and any parsing
error synchronously before awaiting the guard. Changes to the shared host
request while that guard is pending cannot change the captured intent. Guard
denial retains 403 precedence; only a successful guard permits the captured
input error or the original command to proceed to the service.

## HTTP contract

`handlers.handleRequest(request, relativeRoute)` receives a trusted route
relative to `/api/dashboard/ncsc/assessments`; it returns
`{ status, headers, body, isRaw: false }` with existing protected API headers.
The host supplies own data fields `method`, `query` and parsed `body` as
applicable. Relative paths are exact; leading/trailing slash aliases and unknown
subpaths are rejected.

| Method | Relative route | Body or query | Success |
| --- | --- | --- | --- |
| GET | empty string | Optional query `limit`, `afterAssessmentId` | 200 list |
| POST | empty string | Create envelope below | 201 original result |
| GET | `:assessmentId` | No body or query parameters | 200 detail |
| POST | `:assessmentId/save` | Save envelope below | 200 original result |
| POST | `:assessmentId/submit` | Submit envelope below | 200 original result |

```js
// Create. The caller keeps this stable assessment ID for every retry.
{ assessmentId, idempotencyKey, expectedRevision: null,
    payload: { scopePopulation: { description } } }

// Save. The assessment ID comes from the route.
{ idempotencyKey, expectedRevision,
    payload: { responses: [{ itemId, optionId, rationale }] } }

// Submit. The assessment ID comes from the route.
{ idempotencyKey, expectedRevision, payload: {} }
```

Every shown key is required; additional keys are rejected. Action comes from the
route and method. Caller actor, tenant, organisation, time, profile, grant, quota,
audit, approval and evaluation fields are rejected. Save/submit revisions are
nonnegative safe integers. Assessment IDs and idempotency keys use the same
120-character ASCII identifier grammar above.

Save accepts 1–14 unique accepted question IDs, normalized into exact identifier
order. `optionId` must be an option for that question. An applicable option
requires `rationale: null`. An N/A option requires
`rationale: { text: nonblankText }`; clearing an answer uses
`optionId: null, rationale: null`. Unpatched answers remain unchanged. Scope
descriptions and rationale text are retained verbatim, each nonblank and at most
4,000 UTF-16 code units. Text containing U+0000 or an unpaired UTF-16 surrogate
is rejected as `ncsc_input_invalid` before database access because PostgreSQL
JSONB cannot retain it. Valid surrogate pairs, multilingual text and other valid
control characters remain supported without normalization. The complete
normalized command, including server action and
route ID, is limited to 65,536 UTF-8 JSON bytes; oversize input returns 413.
Host parsing and transport limits remain part of POR-010.

List query `limit` is a decimal string from `1` through `100`, with default `50`;
`afterAssessmentId` is an exact ID, absent for the first page. The facade requires
both fields explicitly, with a null first cursor. Pagination uses the same
deterministic bytewise ID order for cursor comparison and ordering. GET bodies
and query parameters on all other operations are rejected.

The item limit is an upper bound. A page also validates at most 256 retained
versions in total, always validating each returned assessment's complete history.
A full 129-version assessment fits an empty page. A page may therefore contain
fewer requested items; whenever an unreturned head remains, its cursor is the
last returned ID. Following that cursor continues without skipping assessments.

The closed success envelopes are:

```js
{ schemaVersion: 1, assessments: [summary], nextAfterAssessmentId }
{ schemaVersion: 1, assessment: detail }
{ schemaVersion: 1, action, assessment: detail } // mutation and exact replay
```

A summary includes only `assessmentId`, `moduleId`, `profileRef`, `status`,
`revision`, `revisionSha256`, `createdAt`, `updatedAt` and `progress`. Detail adds
the scope description, responses with optional rationale text, and either null
submission or `{ revision, submittedAt, responseSetSha256, evaluation }`.
Evaluation is the accepted evaluator's canonical serialized output. Internal
membership, advisor, authority, usage, policy, audit, receipt and evaluation-input
envelopes are never returned. There is no new retry timestamp or replay marker;
the original mutation body and status remain unchanged on exact retry.

Public errors contain only `{ code }`:

| HTTP status | Codes |
| --- | --- |
| 400 | `ncsc_input_invalid`, `ncsc_selected_scope_unsupported` |
| 403 | `ncsc_access_denied` |
| 404 | `ncsc_not_found` |
| 405 | `ncsc_method_not_allowed` (with Allow header) |
| 409 | `ncsc_revision_conflict`, `ncsc_idempotency_conflict`, `ncsc_state_conflict`, `ncsc_quota_exceeded`, `ncsc_submission_unavailable` |
| 413 | `ncsc_request_too_large` |
| 503 | `ncsc_unavailable`, `ncsc_outcome_ambiguous` |

`ncsc_submission_unavailable` is the deterministic, no-write response to
Submit when the configured approved policy source contains no applicable submission policy. The
assessment and its saved answers remain editable: the client may continue
saving, leave and resume the draft. Do not loop on Submit while the manifest
is empty; try it again only after an applicable approved policy is published.
Other policy/provider failures return 503 and remain ambiguous, so the
same-intent reconciliation rules below still apply.

## Durable lifecycle, quota and retry

Create persists revision 0 in `created` state and the server-stamped scope
declaration. Save advances once to `in-progress`; submit requires all 14 answers
and permanently seals the response set. Each version retains its exact canonical
owner, state, scope declaration, active rationale records and initial evidence
and risk records. Submission retains the tenant-bound evaluator input and exact
evaluation, reconstructed from those records without accepting client digests.

`resolveSubmissionQuota(selection)` is a trusted server adapter; it returns a strict policy record or a genuine Promise for one. Selection
has exactly `tenantId`, `organisationId`, `assessmentId`, `actorSubjectKey`,
`moduleId`, `profileRef`, `productGrantId`, `agreementRef`, `expectedRevision`,
`submissionRevision` and `at`. It is detached/frozen and has no transaction
handle. The returned record has exactly:

```js
{ schemaVersion: 1, tenantId, organisationId, productGrantId, agreementRef,
    moduleId, profileRef, policyId, policyRevision, validFrom, validUntil,
    limit: 'assessment_runs', amount }
```

The record must match the transaction's current product, agreement, owner and
accepted profile. Amount is a positive safe integer; revision is nonnegative;
the explicit interval must include execution and final authorization time.
Arbitrary thenable results fail closed; genuine Promises are awaited only on a new submission before writes. The production request guard bounds the wait and rechecks authority/deadline/transaction ownership afterward. The host must derive this policy from the
applicable agreement and retain immutable policy revisions. Synthetic test
policies are explicitly supplied fixtures and establish no commercial cadence.
The existing entitlement engine enforces the current finite limit and usage.

Every mutation takes the canonical tenant `FOR UPDATE` lock before current
authority is loaded. It commits the version, head, optional submission usage,
original public result, original intent, exact transition command, original
policy/grant/counter evidence and successful audit event atomically. A final
post-I/O check is its authorization linearization point. An expiry crossed before
that check rolls back the entire transaction. No external audit delivery is
performed inside a mutation: the successful event is retained in its receipt.
For a new charged submission, the selected product grant must remain the same
and its original interval must still contain that final instant. A future grant
becoming active during I/O cannot authorise a charge against an expired grant.
This rule does not reselect the charge for an already committed receipt replay.

Reads use `FOR SHARE`, validate retained history, await the supplied read audit
sink and check current time-dependent access again before returning. Read audit
or commit failures return 503; they never trigger mutation recovery.

Stable intent contains canonical scope, actor, action, assessment ID, expected
revision and normalized caller declaration/patch. It excludes newly sampled
time, request/event IDs, generated records and current policy. Exact retry first
rechecks today's access, then reconstructs the original transition against its
actual retained predecessor and first-execution facts. It validates the original
result version, digest, audit and original retained grant/usage inclusion. It
does not select or charge today's policy. Restoring a later receipt alongside
older state/counters cannot turn that inconsistency into a successful retry.

An ambiguous commit or rollback permits one fresh transaction that only tries to
reconcile the same intent and idempotency key. It cannot create, write or charge
if the original receipt is absent. Continued ambiguity returns
`ncsc_outcome_ambiguous`; a caller retains the same identifiers when retrying.

## Storage bounds and verification

The additive migration `database/migrations/0004_ncsc_assessments.sql` creates
exactly three tables: `dashboard_ncsc_assessments`,
`dashboard_ncsc_assessment_revisions` and
`dashboard_ncsc_assessment_receipts`. All use scoped keys and FORCE RLS. The
runtime role may select/insert versions and receipts and select/insert/update
heads; it cannot update/delete history or delete heads. Parent references bind
the exact owner, assessment, previous revision and digest. Only revision 0 has a
null parent. Versions reference the canonical organisation; inserting version 0
before its head avoids a cyclic immediate foreign key.

An assessment supports revisions 0–128 inclusive. Saves may produce only 1–127,
reserving revision 128 for final submit. New writes at the ceiling fail without
changing state, receipts or quota. Exact replay and reads remain available. This
is an operational verification bound, not a submission allowance or retention
policy: no version or receipt is truncated, evicted or silently repaired.
Version canonical JSON is at most 256 KiB; receipt JSON is at most 1 MiB. SQL
additionally bounds its JSONB text representation. History is validated in
batches of 16, inclusively from creation to head, with no gap or future orphan.
List pages additionally enforce the 256-version work budget described above.
Every transition is reconstructed through the actual create/save/submit path;
hash-linked but lifecycle-invalid history fails closed. Only the current and
specifically requested versions are retained in memory between batches.

The repository contract tests and independent negative probes exercise rollback,
replay, current authority, mixed restores and lifecycle corruption. The real
PostgreSQL suite is registered by `test/postgresMigration.test.js` and exercises
RLS, constraints, concurrent fences and isolated restore/restart behavior. Run
`npm run test:postgres` against an explicitly supplied synthetic database; a
missing `NOFRIES_TEST_DATABASE_URL` skips real-engine tests and is not passing SQL
evidence. Restored-database pools use the existing pool lifecycle tracker before
database removal. The dated ExecPlan records actual local and hosted results.
