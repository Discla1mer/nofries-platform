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

The control blob is `customer-starter/reset-writer-fence/control.json` in the
starter authority container. Both sides acquire its non-expiring lease before
work. A reset persists its operation/plan marker before deletion and only clears
it on explicit completion. Failure or uncertainty retains exclusion; there is
no time-based takeover or app lease-break API. A retained reset marker blocks
new writers even after someone deliberately breaks the lease.

Every observed Blob write and SQL mutation/COMMIT checks lease ownership before
dispatch and after acknowledgement. A lost lease stops subsequent work and
cannot release a successor's lease. Conditional create/ETag conflicts remain
reconcilable; uncertain remote errors retain the lease.

An operator break cannot cancel an already-dispatched remote write. That case
is tested as uncertain, not claimed atomic. Recovery must stop/drain **all**
writers, settle in-flight effects and reconcile retained evidence before any
explicit break/marker repair under an approved operator policy. A crashed app
writer may retain the common lease even without a reset marker. This source-wide
lease serializes writers and rejects contention; it adds no retry queue.

Fry must reconcile the overlapping fence module and two composition files with
#47, preserve that PR's reset `withReset` integration and adoption checks, and
regenerate `writerImplementationSha256()` from the final combined source. Do not
reuse the old adoption digest. Old/unfenced app instances must be drained before
reset is enabled. #20 alone is insufficient. Versioning, staff acceptance,
listing/auth policy and the non-production reset/rollback rehearsal remain
separate release gates. No release workflow or pinned release file is changed.

## Verification

`node --test test/signupResetWriterParticipation.test.js` exercises real account,
setup and External ID claim adapters with versioned in-memory blobs; absent
record recreation; normal completion; a deliberately broken reset lease;
stale app writes/COMMIT; uncertain in-flight effects; default-off selection; and
the real starter composition's synchronous factory and deferred invocation.
The SQL recorder checks dispatch/exclusion, not native PostgreSQL semantics.

Required application, dependency and PostgreSQL CI must pass on the final head.
These tests are not live Azure lease/version recovery or staff acceptance.
