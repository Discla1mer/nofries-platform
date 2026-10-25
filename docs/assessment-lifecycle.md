# Assessment lifecycle and persistence contract (ENG-002)

This additive domain implements one assessment instance per tenant, organisation
and assessment ID. It is dormant source for synthetic development and tests.
Nothing imports it into a route, runtime storage factory or production workflow.
DATA-001 owns durable storage and migration; later portal work owns admission and
authenticated/authorised access. Do not configure the in-memory reference adapter
as a production fallback.

## Architecture

`api/shared/assessmentLifecycle/assessmentDomain.js` owns strict state validation,
transitions, response patching, immutable framework bindings and progress counts.
It uses the existing tenant domain to require an existing organisation and the
framework registry to resolve the exact published profile. It has no vendor calls,
uploads, customer records, AI, pricing or scoring side effects.

`api/shared/assessmentLifecycle/assessmentRepository.js` provides
`createInMemoryAssessmentRepository({ registry })` and
`createAssessmentLifecycleService({ repository })`. Both expose asynchronous
`read(tenantAggregate, selector)` and `execute(tenantAggregate, command)` methods.
The service normalises inputs; the repository owns the atomic operation. Actor
subject keys identify an already verified actor using the existing membership
domain's `tenant-UUID:object-UUID` form. These values are **not credentials or an
authorisation mechanism**. The future runtime must resolve the organisation and
check current membership, role, entitlement and admission before every call,
including reads, archive and idempotent retries.

## Lifecycle behaviour

| Command | Accepted current state | Result |
| --- | --- | --- |
| `create` | Assessment absent, `expectedRevision: null` | `created`, revision 0, no responses |
| `start` | `created` | `in-progress` |
| `save` | `created`, `in-progress` | `in-progress`; patch listed answers only |
| `submit` | `in-progress`, all questions answered | `submitted`; seal the response digest |
| `review` | `submitted` | `reviewed`; preserve all answers and submission |
| `archive` | Any state except `archived` | `archived`; preserve prior status and history |

Every accepted command after creation increments the revision once. Start and save
may share a timestamp; timestamps cannot move backwards. IDs use the evaluator's
bounded stable-ID format, not display names. Rehydration requires the complete
canonical state: it never invents missing revisions, statuses or historical fields.
Created state is empty; submission, review and archive metadata carry actor,
timestamp and revision and must be consistent with the current state.
An archived in-progress assessment requires at least revision 2: entering
in-progress and archiving are separate mutations. Every retained answer update
must precede the archive revision; archival cannot also edit a response.

Every response records `itemId`, `optionId`, `applicabilityRationaleSha256`, the
full `profileRef`, and its last update actor, timestamp and revision. `profileRef`
contains framework ID/version, profile ID/version, catalogue SHA-256 and the
source-catalogue SHA-256 when the profile supplies one. The assessment additionally
fixes its module ID and population digest. There is no command to replace these
bindings, add a question, change a weight or move answers to another profile.

Saving uses a patch array, not a replacement snapshot. `optionId: null` clears an
answer; the rationale must also be null. Omitting an item leaves its answer
untouched. Unknown question IDs, options not offered for that question, duplicate
items, extra fields and invalid rationale digests fail the whole operation. The
maximum patch and retained response count is 1,024 questions.

`getAssessmentProgress(state, registry)` returns exact `total`, `answered`,
`missing`, `unknown` and `notApplicableClaims` counts. Missing remains unanswered.
An explicit unknown option offered by the profile counts as answered but unknown.
An N/A response is only a claim; its required rationale is a digest pointer, never
raw customer evidence. Lifecycle review does not approve N/A, verify evidence,
certify compliance or alter attainment. Partial assessments remain resumable
drafts until every question has an explicit answer. A submitted response set is
immutable; corrections require a new assessment instance in this initial slice.

Submission fixes `responseSetSha256`, hashing the complete scoped, profile-bound
response set, including update provenance. Rehydration verifies this digest;
review and archive preserve it. This digest detects accidental content drift; it
does not authenticate a malicious writer with access to the whole database.

## Commands and retries

Every command requires these exact fields:

```javascript
{
    tenantId, organisationId, assessmentId,
    action, payload, expectedRevision, actorSubjectKey,
    now, idempotencyKey
}
```

Creation payload requires `{ moduleId, profileRef, scopePopulationSha256 }`. Save
requires `{ responses: [{ itemId, optionId, applicabilityRationaleSha256 }] }`.
Other actions require an empty object. Profile versions are exact; `latest` is
rejected. All times are canonical UTC instants (`YYYY-MM-DDTHH:mm:ss.sssZ`).

The reference adapter returns `{ state, commandSha256, replayed }`. Receipt keys
are scoped to the JSON tuple `[tenantId, organisationId, assessmentId]` plus the
idempotency key. The command fingerprint includes the actor, action, expected
revision and canonical payload. Response order is normalised. The service clock
is excluded, allowing a request to be retried at a later time while returning the
original committed timestamp and response. The idempotency key is excluded from
the fingerprint because it selects the receipt.

An identical retry returns the original committed result even if newer edits
exist; call `read` to resume from the latest state. Reusing a key with changed
intent returns `assessment_idempotency_conflict` (409). A stale edit under a new
key returns `assessment_revision_conflict` (409); read the current revision,
resolve the competing edit, then issue the intended command. Failed operations
commit neither state nor receipt, so a corrected command can use its uncommitted
key. Parallel identical commands converge on one receipt. Parallel different
commands at one revision have one winner.

The in-memory adapter has one synchronous commit point that replaces the state
and its receipt map together. No `await` separates revision validation from the
commit. It retains at most 64 assessments and 128 receipts per assessment. When
full it returns `assessment_reference_capacity_reached` (503), preserving state
and earlier receipts. It never evicts receipts or silently weakens retry safety.
Process restart loses all reference state; that is an explicit test-only boundary.

Reads require a valid tenant/organisation selector but allow historical reads for
an inactive organisation. Mutations other than archive require an active tenant
and organisation, including receipt replay. Archive retains the assessment and
its history and is terminal in this initial slice. Wrong tenant, organisation or assessment
selection returns `assessment_not_found` (404) without returning another scope's
record or receipt.

## DATA-001 production adapter acceptance

Production activation must preserve this contract while adding durable storage:

- Commit the new revision and idempotency receipt in one database transaction.
  Enforce uniqueness across tenant, organisation, assessment and operation key.
- Conditionally write the expected revision; ensure competing processes have one
  winner. A read-then-unconditional-write implementation is insufficient.
- Normalise and validate stored state on load. Retain every referenced published
  profile version and digest. Missing or replaced versions fail closed; there is
  no fallback to the newest profile.
- Persist the original response receipt, or an immutable reference to that exact
  revision, so retries after later mutations cannot return the wrong result.
- Define a bounded, explicit retention/retry window without silently forgetting
  keys. Define transaction timeout, cancellation and crash recovery semantics.
- Add database integration tests for cross-tenant collisions, simultaneous writes,
  commit-before-response loss, rollback-before-commit, restart and restoration.
- Integrate verified identity, role/entitlement checks, admission controls, privacy
  and audit logging before using real customer information. Complete the required
  First-Customer Security Gate and exact release approval for those changes.

This source slice adds no schema, migration, privileged dependency or environment
variable. Production storage, arbitrary customer evidence and admission remain
outside its release claim.

## Scoring integration

Scoring remains in `api/shared/assessmentEngine/assessmentEvaluator.js`. A later
trusted adapter must use the retained exact profile, fixed population digest,
submitted revision and submitted time, and independently verified evidence/risk
snapshots and applicability decisions. It must not treat lifecycle `reviewed` as
an applicability approval. This slice stores no score and exposes no score setter.
The synthetic integration test constructs evaluator inputs from a submitted
response set and proves byte-equivalent evaluator output before and after
lifecycle review, with zero approved N/A exclusions.

## Verification

Run from repository root:

```sh
node --test test/assessmentDomain.test.js test/assessmentRepository.test.js
node node_modules/jest/bin/jest.js --runInBand test/assessmentDomain.test.js test/assessmentRepository.test.js test/tenantDomain.test.js test/membershipDomain.test.js test/frameworkProfileRegistry.test.js test/assessmentEvaluator.test.js
```

Final local result: 41 new tests and all 170 tests across six targeted suites
passed. Tests cover lifecycle, partial save/clear, missing/unknown/N/A, status
tampering, exact profile retention, tenant isolation, concurrency, receipt replay,
failure atomicity, invalid shapes and unchanged evaluator behaviour. Independent
review found and verified correction of the required N/A rationale before a
response can be sealed. Hosted review additionally identified impossible archived
in-progress history; the revision-continuity correction passed two regressions
that reproduced the defect before correction and independent re-review with no
unresolved correction findings. Hosted
required checks and release evidence are recorded by the parent delivery lane.
