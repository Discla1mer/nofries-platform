# App participation in the empty-signup reset fence

Refs #16. This change supplies the app half of the shared lease protocol from
#47, prepared independently from current main. It does not enable reset or change infrastructure. #20's leases
on existing target blobs cannot prevent a writer creating an absent record;
the reset must also hold the common source fence supplied by #47.

## Writer map

| Records / operation | App writer | Exclusion |
| --- | --- | --- |
| Account pointer and replacements | `AzureStarterAccountStore`, account allocation and activation | Decorated starter container and outer starter operation |
| Organisation setup details | `AzureStarterSetupStore`, `setup.save` | Decorated starter container and outer setup operation |
| Organisation context and subject authority | `externalStarterClaim` | Decorated starter container and outer claim operation |
| Invitations and signup admission evidence | Session/starter stores used by customer signup | Both containers use the same starter-source fence |
| Organisation preparation, terms journal, registration and activation SQL | Customer signup / starter client operations | Outer operation lease plus observed pool mutations and COMMIT |

`customerSignupProduction` selects the fence before constructing stores. The
starter and session containers acquire it even for direct writes. Whole signup,
claim, setup, preparation, activation and client operations retain it across
their reads and writes. Nested calls reuse the same scope. The client factory
stays synchronous; only its returned async methods acquire a lease. Read-only
quota and recovery selectors retain their existing call contracts. Legacy
authority is outside this External ID reset scope.

## Contract and rollout boundary

The existing #47 opt-in is `NOFRIES_SIGNUP_RESET_WRITER_CONTRACT=external_signup_writers_v1`.
Absent/empty is off; unknown values fail closed. Only the External ID starter
source participates. Scope is the hash of the authority storage account name,
starter authority container name and contract. App and reset must use identical
values. No settings are changed by this PR.

The control blob remains `customer-starter/reset-writer-fence/control.json` in the
same starter authority container and scope. Schema 2 adds a durable `writer`
operation ID alongside the mutually exclusive `reset` operation/plan marker.
The infinite lease is acquired before reading control; application dispatch is
forbidden until the intent upload acknowledges under that lease. Failed or
unknown acknowledgement never starts application work. Every observed Blob write
and SQL mutation/COMMIT checks ownership before dispatch and after acknowledgement.

Pending work is counted synchronously before its first await. The owner closes
before deciding whether to publish idle. Only successful, joined work with no
uncertainty can clear intent under the original lease and release it. Callback
failure, pending work, uncertain swallowed errors or lease loss retains intent.
Settled conditional-create/ETag conflicts remain reconcilable if the callback
successfully reconciles them. This intentionally sacrifices availability on an
unhandled callback failure, even if it appears to have had no effect.

Reset `complete()` first refuses pending work and closes the context synchronously.
It requests completion; it never clears control itself. The owner publishes idle
only after the outer callback settles successfully and ownership is rechecked.
Detached completion, a throw after completion, and a stale lease cannot clear a
retained marker or a successor's marker. A lost clear acknowledgement after all
work joined is safe for exclusion: no application write remains pending, but the
caller still cannot infer successful completion from an uncertain response.

The infinite lease has no natural expiry. Elapsed time does not permit takeover.
After loss or an external break, a new process reads the retained writer/reset
intent and refuses **even the same operation**. This code never breaks, repairs,
or automatically adopts a retained fence. `readReset() === null` is not an idle
probe: a writer intent may still exist. Use admission, never that read, for safety.

Schema 1 (including apparently idle control) and malformed control are quarantined.
Older strict readers also reject schema 2. There is no rolling mixed-schema
migration: Fry needs separately qualified stopped admission, old-writer drainage,
issued-call reconciliation and offline control migration before any activation.
The contract/key/scope do not change, so a new namespace cannot bypass old intent.

A fence cannot make separate Blob/SQL effects atomic. An already-dispatched write
can land after a crash or lease loss and leave physical partial state. The proven
property is exclusion and quarantine: no successor reset/signup may adopt it,
continue deletion, overwrite it or report that uncertain work completed. A trusted
recovery host must reconcile it before admission resumes. This PR provides no such
host and makes no claim that production can never contain an orphan or partial row.

See [the reconciled stack and #47 handoff](signup-fence-reconciliation.md).

## Verification

`node --test test/signupResetWriterParticipation.test.js` exercises real account,
setup and External ID claim adapters with versioned in-memory blobs; absent
record recreation; normal completion; a deliberately broken reset lease;
stale app writes/COMMIT; uncertain in-flight effects; default-off selection; and
the real starter composition's synchronous factory and deferred invocation.
The SQL recorder checks dispatch/exclusion, not native PostgreSQL semantics.

`node --test test/signupWriterFencePending.test.js` exercises the real index,
allocator and account store with a one-second index budget and a gated SDK
upload. Both create and replace keep the common lease after the index times out,
before and after the late upload lands; fresh writers and resets stay blocked.
The same regressions fail against the original #55 fence. The production index
budget remains 60 seconds; an upload starting near its deadline has the same
race. Further tests pause nested entry, pre-dispatch renewal, upload, post-ack
renewal, SQL COMMIT and reset completion across early race/all failure and
detached success. They preserve ROLLBACK cleanup, known conflicts, normal nesting
and callback errors. The guarded reset tests additionally exercise the actual reset coordinator
under the common fence with synthetic target storage; #47 is not wired here.

Required application, dependency and PostgreSQL CI must pass on the final head.
These tests are not live Azure lease/version recovery or staff acceptance.
