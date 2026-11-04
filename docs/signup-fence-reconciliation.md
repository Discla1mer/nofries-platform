# Reconciled signup/reset fence

Refs #16. Proposed single stack: **#55 → #57 → this reconciliation → adapted #47**.
No existing PR is closed, merged or modified by this proposal.

| PR / immutable input | Disposition |
| --- | --- |
| #55 `2d830fdc9e5ec0ccd3339fbc943a3f02e67a6273` | Keep writer coverage and default-off selectors. |
| #57 `d2a53df3c6961fde3b553f1813c7582b53eebbda` | Keep pending-write tracking; this PR is stacked on this exact head and corrects durable intent/completion. |
| #56 `0216d71ab15e35dfbfd59badea239ab52efd66b3` | Consolidate its dormant guarded command, runbook and tests here; supersede its separate landing if Fry accepts this stack. Target-only retry is replaced by common-fence quarantine. |
| #59 `6d53a84226ac2ab1cc8ff2785cbba42a2f0e6510` | Consolidate its unchanged read-only recovery evaluator and tests here; supersede its separate landing if accepted. No execution authority. |
| #47 `cbeaa7d95023d542ebc1ed14d5e7ceebb9393ffd` | Keep portal work as downstream dependency; reconcile and requalify on this stack before reset enablement. Its branch is untouched. |

## Safety argument

Lease-only exclusion fails if a remote write remains pending when the lease is lost:
a new holder sees idle and can delete pointers before the old write lands. Schema 2
persists either writer intent or reset intent before application dispatch. Losing the
lease does not erase that evidence. New instances and retries refuse retained intent.

Reset completion cannot publish idle while observed effects are pending. It closes
entry synchronously, records a completion request, and defers the lease-conditioned
clear to successful owner settlement. Unknown outcomes retain exclusion. Target-only
leases cannot exclude creation of absent records, so the dormant guarded command now
requires both common and target fences and observes its delete/restore promises.

This is an exclusion guarantee under the trusted-port/writer-participation contract,
not a distributed transaction. Crashes may leave physical partial state. Tests assert
that it is quarantined, cannot be adopted by a successor, and is not reported as a
successful reset. They do not prove live Azure, PostgreSQL, controller provenance,
complete production writer participation or a recovery host. There is no reset route,
production operation, lease-break API or automatic retained-operation resumption here.

## #47 handoff

- Rebase/reconcile its overlapping common fence, production selectors, account/reset
  tests and versioned-blob helper onto this stack; do not restore its schema-1 reader.
- Keep its protected `readAdoption` and `withReset` wrapper, target version/ETag leases,
  index checks, authority/audit checks and missing-authority policy. Await `complete()`
  as the final callback action. Successful owner settlement performs the actual clear.
- Recompute `writerImplementationSha256()` over the final seven writer files; retain
  exact source, instance, restore epoch, source binding, expiry and old-writer drainage
  checks. Existing adoption evidence is invalid after these source changes.
- The control key/contract/scope stay unchanged. Both old readers on schema 2 and new
  readers on schema 1 fail closed. Even idle schema 1 needs separately qualified
  stopped admission, drainage and offline migration; this PR performs none.
- `readReset() === null` does not prove idle (a writer intent may exist). No retry or
  rollback may bypass retained common intent. #59's eligibility boolean authorizes
  neither marker repair nor lease release. Adapt/retest portal flows before enabling.

## Reproducible evidence

`npm test -- --runInBand test/signupFenceReconciliation.test.js test/emptySignupReset.test.js test/signupWriterFencePending.test.js test/signupResetWriterParticipation.test.js test/retainedWriterRecoveryPlan.test.js`

The focused tests cover real account/index adapters, pending writes during reset
admission, retained empty-reset effects, repeated retries, lease loss, non-expiring
lease time advancement, restart, lost intent acknowledgement, stale conditional clear,
completion with pending work, failure after completion, schema migration refusal,
immutable receipt replay and completed-reset rollback. Gates control interleavings;
no timing sleeps or production resets are used. Required CI and independent review
are recorded on the PR and the private coordination issue.
