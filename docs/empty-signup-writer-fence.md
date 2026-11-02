# Empty-signup writer fence

Issue [#16](https://github.com/Discla1mer/nofries-platform/issues/16) remains open
until writer deployment and the separately reviewed operator binding are ready.
The public binding grants no deployment or account-reset authority.

The replacement for PR #20 uses permanent per-record lock blobs in each target's
own container. Application writes and resets acquire unique infinite leases on
these same locks. Deleting an account or subject never deletes its lock. A live
holder cannot be superseded, including by another invocation of the same reset.
An operation and its exact plan digest own both retained markers. Completion
clears the markers while both leases remain held, then releases the leases.
A cleanup failure leaves an orphaned lock; it cannot undo the completed outcome.

## Deployment prerequisites

- All account and subject writers, including private operator tools, must use
  `withCustomerRecordWrite` before invoking the reset binding. Checking a marker
  and then writing outside its lease is unsafe. Old application instances and
  background workers must be drained before reset activation.
- Both target containers need Blob versioning and a retention/lifecycle policy
  that preserves the inventoried versions and permanent lock blobs. Confirm the
  exact two original versions are readable before each operation. No configuration
  changes are included here.
- The operator inventory and recovery inspectors must recheck exact source,
  target/container binding, SQL emptiness, dependencies and immutable versions.
  Production wiring and an actual non-production Azure rehearsal are separate
  review gates; the synthetic tests do not prove either.

## Recovery policy requiring owner acceptance

A normal retained operation releases its control leases after persisting both
markers, allowing the same operation and plan to resume. An uncertain target
write or a process crash leaves infinite leases held. There is no automatic
takeover, timeout expiry, HTTP recovery endpoint or lease-break function.

An authorised operator must first stop the former process and drain its outstanding
storage requests, verify the exact operation, plan, containers and original
versions, then record the decision in protected audit evidence. Only then may
they break the orphaned control leases, preserving retained markers, and resume
the same rollback. Never break a live holder's lease. If quiescence or the write
outcome cannot be established, keep the target blocked. A completed operation's
orphaned open lock needs the same quiescence check before cleanup.

Azure's [lease contract](https://learn.microsoft.com/en-us/rest/api/storageservices/lease-blob)
protects the leased blob; participation by every target writer is essential.
