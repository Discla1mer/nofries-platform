# Guarded paid-entitlement bridge — Joel's decision required

**Proposal only. Default OFF and UNWIRED. Not an operational payment or access feature.**

For customer #1, use the invoicing recommendation in [#77](https://github.com/Discla1mer/nofries-platform/pull/77): Joel verifies settlement outside No Fries, then an independently authorised operator records one finite paid term for one existing organisation. The proposed flag is **additional eligibility**, never identity, membership, an admin role, a product grant or proof that a payment cleared. There is no payment provider, billing account, key, webhook or automatic renewal here.

## What this PR actually delivers

A tested, default-off adapter **design contract** at `api/shared/paidEntitlement/adminBridge.js`, with synthetic transactional tests. No production module imports it. There is no database migration/store, route, UI, environment switch, signup change or entitlement consumer. `enabled: true` exists only in tests. False/omitted refuses all operations before reading storage.

This PR starts on public main and does not edit [#47](https://github.com/Discla1mer/nofries-platform/pull/47)'s owned files. It is intentionally **not plug-compatible with #47 today**: #47's closed action/inspection codecs do not admit `paid_entitlement`. The future integration below needs a separate review after #47 lands. Tests demonstrate the adapter contract, not a production database or end-to-end admin action.

## Proposed #47 flow (not implemented)

1. Restricted admin uses #47's exact account lookup (provider + immutable subject + tenant + org); the selected organisation must be active and the binding current. Lookup/list permissions alone must never authorise this action. A separate, scoped `paid_entitlement` operator approval is required.
2. Extend #47's action codec and inspection preview to show **current flag, revision, end date, opaque agreement reference**, and the proposed values. Operator types the current canonical organisation name to confirm both enable and disable. The name is checked but never retained in the command/audit.
3. Use #47's hashed random confirmation token, actor-bound immutable command, maximum five-minute expiry, current-authority checks and outcome reconciliation. The adapter's command shape follows that contract; it does not mint or authenticate confirmation tokens itself. Browser input must never call this adapter directly.
4. Under the existing tenant writer fence, reload current authority and org state, compare the preview version/binding/restore epoch, then atomically write the org flag, audit event and operation receipt. Current authorisation, request deadline, cancellation and confirmation/term expiry are rechecked at the final transaction commit boundary. If any check or audit write fails, roll everything back.
5. A successful retry returns its retained receipt rather than a second write. Expired confirmations may only reconcile a prior outcome. Concurrent changes invalidate stale previews. A disable clears current term/reference but retains the audit history; it does not delete customer data or revoke membership.

## Record and storage contract

| Item | Proposed minimal content / ownership |
|---|---|
| Org flag | `schemaVersion`, tenant ID, org ID, monotonic revision, `enabled` boolean, UTC `validUntil`, opaque UUID `agreementRef` |
| Initial state | Explicit disabled revision 0, null term/reference; missing/corrupt/unavailable authority or storage fails closed |
| Enabled state | Finite future expiry and opaque agreement UUID required; no arbitrary invoice text, amounts, card/bank details or email |
| Audit | Actor subject, target digest, operation ID, command digest, restore epoch, before/after flag records and timestamp |
| Receipt | Operation ID, command digest, succeeded status, event digest/version, timestamp; exact command match required |
| Financial evidence | Remains in Joel's separately controlled accounting records; UUID provides a private link, not a public invoice number |

The injected store is trusted infrastructure, not a network endpoint. `transaction(scope, work, commitGuard)` must lock by **tenant and org**, not by customer subject, and serialize both writes and outcome reads with #47's native transaction/fence. `snapshot(selector)` must return a validated active org and current authorised binding whose digest covers all relevant revisions/statuses; `receipt(operationId)` returns only scoped retained evidence; `save({record,event,receipt})` stages all three atomically. After its final await, the store must invoke `commitGuard` immediately before committing; errors/aborts roll back. The in-memory test implementation is only a contract harness, never an acceptable production store.

A future native implementation must integrate [#61](https://github.com/Discla1mer/nofries-platform/pull/61) and its reviewed successors: no writing around an active empty-signup reset, lease/fence loss or restore. Recovery must reconcile flag and audit under the new restore epoch; old confirmations must fail. No reset/delete path is added or enabled. Native SQL locking, fence-break, rollback, cancellation and recovery tests are activation prerequisites, not established by these unit tests.

## Signup, access and privacy boundaries

Normal verified signup still creates identity/membership under existing policy. It never sets this flag from an email, query parameter, client payload or invoice reference. For the first invoice, the operator selects an already established org. Consultant accounts need an explicit org-by-org commercial decision; no cross-client blanket flag.

A future **server-side** paid gate must require current authenticated scope, canonical membership/product entitlement, and a non-expired paid term together. It must also define safe access to support, export and deletion requests after expiry. A boolean alone cannot extend today's finite signup/admission/product grants; that renewal lifecycle remains separately reviewed work. This PR does not make customer #1 payable or bypass existing expiry checks.

The flag, agreement reference and audit are personal/account-linked data. Apply [#74](https://github.com/Discla1mer/nofries-platform/pull/74)'s inventory, draft notice and export/delete design before activation: restricted operator access, no raw financial evidence in diagnostics, customer export scope, access/correction process, retention of necessary audit/financial evidence and honest deletion exceptions. Do not claim a new retention period or production storage region from this proposal.

## Decisions for Joel (none assumed approved)

- Approve manual invoice + bank transfer, the commercial offer, service start and finite paid period; identify who independently verifies settlement.
- Approve org-scoped flag semantics, authorised staff, invoice/UUID mapping and whether one operator or dual approval is required.
- Choose renewal, expiry/grace, disputed payment/refund and consultant multi-org rules; decide which support/export paths stay available after paid access ends.
- Approve privacy/legal wording and retention/export/deletion treatment with #74's review; nominate accounting record ownership.
- Decide whether to commission the separate #47 native integration and server gate. Activation requires reviewed wiring, live prerequisites and release-owner approval; merging this design alone activates nothing.

## Verification

Tests cover default-off, finite metadata, atomic audit rollback, final-boundary revocation/expiry, stale binding/restore/name/revision, cross-org record rejection, actor/command/receipt mismatch, concurrent retries and competing commands, disabling, expired receipt reconciliation, and absence of runtime imports. Hosted application/native-database/dependency checks are reported on the PR and [release record #686](https://github.com/Discla1mer/NoFries/issues/686).
