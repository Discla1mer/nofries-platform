# Admin account actions

Refs #45. PR #47 extends the recovered private PR677 account-action port. It uses the existing staff BFF identity, native operator session/restore-epoch checks, exact target approvals and tenant-isolated data layer. It does not create admin identities, role assignments, database grants or storage containers.

| Action | Effect | Boundaries |
| --- | --- | --- |
| Search | Searches the currently authorised signup pages in browser memory. | Search text never enters URLs or logs. Unknown milestones remain unknown. |
| Members | Shows every saved membership and invitation in the selected organisation, including status, roles and validity dates. | Requires explicit `list_members` in the independent target approval. The old lookup/listing policies grant no additional disclosure. |
| Edit label | Changes the staff-facing label for one identity and organisation. | Canonical organisation names, identities, accepted signup evidence and access stay unchanged. |
| Remove / restore | Suspends one organisation membership; restores only a matching removal with unchanged eligible state. | Other organisations, roles, validity dates and stored data are preserved. |
| Delete / recover | Suspends the whole organisation and permits recovery from its matching receipt/revision. | Requires typing the organisation name. No data purge or automatic permanent deletion. |
| Reset stuck signup | Removes the version-pinned account pointer and optional subject-authority pointer of an eligible half-created External ID signup. Publishes an index tombstone before releasing writers. | Requires typing the organisation name. Refuses ANY SQL starter account/scope, canonical tenant or signup registration. Existing identities, setup/claim/legal evidence and trial/admission reservations are retained. |

An `organisation_preparation` failure is resettable only if its native transaction left no canonical state. A failure after SQL preparation committed is **not** eligible. Legacy invitation signups and provider-only identities before application allocation are outside this reset version.

## Routes and confirmation

Four exact JSON POST routes under `/api/dashboard-admin/actions/`: `inspect`, `prepare`, `execute`, `outcome`. Their SWA roles are exactly `["admin"]`; unrelated paths, methods and permissions are unchanged. SWA role authentication and the staff BFF session are separate checks: both must pass. The application does not assign SWA roles or replace the existing role provider.

Handlers require the genuine staff BFF admin identity, exact configured Origin, `Sec-Fetch-Site: same-origin`, no query string, bounded JSON and current independent action approval. Session/role and native approval checks repeat around I/O and before mutation. The server never trusts caller-supplied identity headers.

`prepare` stores an immutable actor/target/version/approval-bound command and returns a random opaque token with a maximum five-minute lifetime. Typed names are checked and discarded. `execute` first reconciles the same command's outcome; it cannot silently create a new operation. Expiry/cancellation blocks further dispatch. The browser keeps no customer state in local storage, session storage or URLs, and clears protected views on revocation/navigation.

## Customer state and audit evidence

Labels, original membership witnesses and command payloads are customer action state in the private `dashboard-admin/customer-action-state/` blob namespace. SQL action audit receipts retain only IDs, action/status, revisions and a content hash reference. Reconciliation requires that immutable state to exist and match its hash; missing/corrupt state fails closed. Native membership effects and their SQL receipts commit in one transaction. A harmless orphan customer-state blob may remain after a rolled-back SQL transaction.

Reset has separate immutable, closed-schema audit records under `dashboard-admin/audit/signup-reset/`: inspection, requested and completed. They contain only actor/operation IDs, target/command hashes, timestamps and outcome evidence. Missing acknowledgement is reconciled to exact retained bytes. An uncertain reset remains pending; it is never reported as an expired, unstarted operation merely because the HTTP response was lost.

## Reset dependency hold

Production signup reset is **disabled in source** in this refresh. The production
admin factory neither constructs the reset adapter from settings nor accepts an
injected reset adapter. The runtime refuses reset authorisation without that
adapter, including a retained confirmation prepared before the hold. Search,
member lists and non-reset actions retain their existing guards. The UI explains
that reset is disabled; it must not be recorded as an acceptance pass.

The separate fence work must reconcile [#55](https://github.com/Discla1mer/nofries-platform/pull/55),
[#56](https://github.com/Discla1mer/nofries-platform/pull/56),
[#57](https://github.com/Discla1mer/nofries-platform/pull/57) and
[#59](https://github.com/Discla1mer/nofries-platform/pull/59).
This refresh preserves the existing fence files byte-for-byte; it does not
claim their race is fixed or qualify their adoption. Tests of the retained reset
coordinator are preparation evidence only, not production enablement.

Re-enabling needs a separate reviewed source change **after** the reconciled
fence lands, all writers adopt it, old writers drain, actual version restoration
and crash/recovery rehearsals pass, and protected adoption/action approvals are
current. A settings change, green #47/#55 CI or admin role alone cannot release
this hold. Keep existing writer contracts, retained fences, versions and receipts
intact. Never use a lease timeout or a manual lease break as reset recovery.

## Production composition

`NOFRIES_DASHBOARD_ADMIN_ACTION_BINDING` selects existing stores using exactly `{schemaVersion:1, authorityContainer, stateContainer}`. Stores must be separate from each other and from auth/proof/epoch/customer-authority containers; the data and browser-auth storage accounts must differ. Managed identity uses the established application construction. Missing configuration stays disabled. Construction performs no provisioning, approval publication or permission change.

Protected action approvals are read fresh from `dashboard-admin/action-approvals/<hash-of-actor-and-instance>/<hash-of-selector>.json`; `capability.json` is a current independent approval used only to establish capability availability. Each selected target must match its own record. Existing approval codec, one-hour validity, audit policy, identity policy, instance, restore epoch and observed revision checks remain mandatory. The source application cannot publish these approvals.

After the source hold is separately lifted, reset additionally requires the existing external signup-index binding, `NOFRIES_SIGNUP_RESET_WRITER_CONTRACT=external_signup_writers_v1` and `NOFRIES_DASHBOARD_ADMIN_RESET_SOURCE_SHA` selecting the exact approved source. Production wraps the external signup and setup entrypoints in a shared, non-expiring writer lease. This covers account creation, setup, claim/authority creation, preparation, acceptance and activation. SDK writes and native mutation/COMMIT errors are observed before adapters can hide them; ambiguous writes retain the lease. Ordinary validation failures release it. SQL rollback remains available for cleanup.

The private controller must independently publish a versioned `dashboard-admin/reset-writer-adoption.json` in the protected approval container. It pins the exact writer implementation digest, source commit, source binding, instance and restore epoch; attests old writers have stopped and version recovery was verified; and expires within one hour. The application only reads it. See `writerImplementationSha256()` and the closed codec in `lib/dashboardAdminSignupResetProduction.js`. A flag or an operator's browser request cannot substitute for this gate.

Reset reuses `emptySignupReset` and the version/lease design from #20. The retained common writer lease is intended to close #20's missing-blob recreation race; the PRs listed above must reconcile its remaining concurrency gaps before activation. The original coordinator now supports a genuinely absent authority pointer and preserves that absence on rollback. Original versions are verified before deletion, inventory and ETags are rechecked under exclusion, account deletion precedes authority deletion, and every effect is reconciled. The index journals removal and publishes its tombstone before another allocation can use that email key.

An uncertain reset, lost worker or uncertain remote write deliberately retains its infinite lease and recovery evidence. No code breaks leases, retries a fresh reset, purges retained data or restores authority automatically. Recovery requires the existing protected operator/controller process to establish that prior workers have stopped, inspect versions and dependencies, and explicitly reconcile or roll back. Do not clear a fence simply because a timeout elapsed.

## Release qualification

Keep this PR unmerged until signup diagnostics and then batch 2 have completed. CI and the independent review are required on the final candidate; predecessor changes require compatibility validation. Promptfoo remains blocked in this Work session; use deterministic local mock evaluations. Do not alter required hosted checks.

`node scripts/dashboard-admin-account-actions-readiness.js` verifies only the ordered source route rules, including admin-only action POSTs and unchanged adjacent guards. It does not prove SWA edge reachability or staff role/session configuration.

Before enabling, the private release controller must accept the exact source/settings/store bindings and current independent approvals. Qualify the genuine staff journey through SWA with Joel's existing admin identity/role and synthetic disposable accounts, including scoped removal/restoration, typed-name soft deletion/recovery, reset refusal cases, revoked sessions, lost outcomes and version recovery. No live operation or permission change is authorised by a public CI pass. If an existing gate needs a human step, stage the candidate and leave that gate for Joel.
