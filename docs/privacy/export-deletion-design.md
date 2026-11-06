# Customer export, correction and deletion — design only

**DRAFT FOR JOEL'S LEGAL REVIEW — not legal advice. No production implementation or authorisation.** This document proposes a future service; no route, worker, migration, permission, provider call or destructive command is added. Dependencies are pinned in the [inventory](data-handling-readiness.md).

## Existing capabilities and boundaries

- Main's lifecycle organisation JSON export includes that workspace's context, conversations, audit, observability and related operator records. It is not a search/export of every record about a person across signup, identity, dashboard and providers. Existing legacy customer deletion has linkage/offboarding checks and is similarly limited.
- [#47 organisationDeletion.js at the reviewed head](https://github.com/Discla1mer/nofries-platform/blob/685636aea724491bb4eed2d1c974e16a709f0948/api/shared/dashboardAdmin/organisationDeletion.js) changes lifecycle status to `suspended`/`active`. It explicitly erases no identities, memberships or assessment rows. Call this **archive/restore**, not privacy erasure. Reuse its restricted admin role, exact target approval, confirmation, revision checks and minimised audit pattern only after review.
- #47's production empty-signup reset is disabled. [#61 reconciliation design](https://github.com/Discla1mer/nofries-platform/blob/4c1d4305df436799251e432e0320735c36d980b1/docs/signup-fence-reconciliation.md) orders #55 → #57 → #61 → adapted #47. Its common/target fence protects participating signup/reset writers; it does not automatically fence assessment saves, membership changes, lifecycle/support writers or provider systems.
- Keep the accepted-terms audit binding immutable. Never run empty-signup reset against an accepted paying customer's records. Retained reset intent, failed cleanup or `readReset() === null` must not be interpreted as global permission to write/delete. The [target-lease findings](https://github.com/Discla1mer/NoFries/issues/686#issuecomment-6633604755) require qualification by the fence owner before any reuse.

## Request types and authority

| Request | Authorisation and scope |
| --- | --- |
| Personal-information access/correction | Verify the individual or authorised representative proportionately; search information about that person, including outside their current membership. Revoked login alone must not block statutory access. Review other people's information and lawful withholding grounds. |
| Organisation export | Verify current organisation authority and purpose. Export only that organisation's permitted business data; separate restricted security/audit details and others' personal information. Consultant membership in one client is not authority over another. |
| Close account/remove member | Revoke the relevant access/identity binding after verified authority; assess shared memberships, sole-owner transfer and active client obligations. Preserve independently owned client records where justified. |
| Archive organisation | Use the reviewed #47 recoverable operation with an explicit statement that data remains. No claim of completed deletion. |
| Erasure/disposal | Separate, reviewed scope and retention decision, with confirmation after a dry-run manifest. No general Privacy Act erasure right is assumed. Decline/defer particular removals only with documented reasons, retention period/review date and a contact for challenge. |

A privacy officer owns intake and response. Record case ID, request type/date, verification outcome (not identity-document copies by default), subject/tenant/org IDs, scope, assigned reviewer, response due date and any lawful extension. Under the [OPC access guidance](https://www.privacy.org.nz/resources-and-learning/knowledge-base/view/7/), the generally 20-working-day period concerns the access decision; it is not a universal export/deletion completion promise. Give access without undue delay after granting it. Legal review must define transfer, withholding, extension, charge and complaint procedures.

## Read-only discovery and export

1. Resolve the verified subject to all authorised identity partitions and membership/organisation mappings. An email match alone is neither identity proof nor permission to enumerate another tenant.
2. Search every inventory class: identity/session, durable signup/invitations, acceptance/schedules, dashboard/admission, assessment revisions/results, improvements/evidence metadata, lifecycle/sales/support, security/audit and enabled providers. Record unavailable stores and unsupported modules explicitly; a failed store must not become an empty successful export.
3. Produce a restricted inventory preview with counts, categories, source versions/revisions and exclusions. Separate personal-information access from whole-organisation export. Review free text, linked identities, provider content and third-party rights before inclusion; record reasons for withholding/redaction.
4. Assemble a consistent snapshot using store revisions and a manifest of capture times/watermarks. Retry or clearly identify bounded changes; do not claim a cross-store atomic snapshot. Include machine-readable JSON, a readable index/data dictionary, schema version, provenance and a checksum manifest. Include history and corrections within the approved scope.
5. Exclude secrets, cookies, tokens, provider credentials and unrelated tenant data. Secrets embedded in user free text require review/redaction rather than unsafe copying. Hashes/IDs are not automatically safe to disclose.
6. Deliver through an authenticated, re-authorised, short-lived download with `no-store`, expiry and revocation. Email a neutral notification, not a data attachment or bearer link containing identifiers. Record recipient verification and delivery outcome; delete staging packages under a separately approved short retention period. This delivery facility does not exist merely because it is designed here.

## Correction and statements

Verify scope, show the proposed correction to the reviewer and retain provenance. Mutable facts use version checks; revisioned assessments receive a new authorised revision. For immutable acceptance/audit proof, attach a separately scoped correction or disputed-fact statement and ensure relevant readers/exports include it. Do not rewrite the historical digest or record a new consent on somebody's behalf. Assess notification to previous recipients under IPP 7. Record a reasoned refusal and the ability to attach the person's statement where applicable.

## Deletion state machine and checkpoints

The future operation must persist one case/operation ID and advance only on verified receipts. Suggested states: `requested`, `verified`, `inventoried`, `awaiting_approval`, `quiescing`, `processing`, `verifying`, `residuals_pending`, `completed`; failures become `blocked` with a resumable checkpoint. Export is optional and separately authorised, not a precondition that delays a statutory request. No state below authorises an operation today.

| Stage | Required behaviour |
| --- | --- |
| Inventory / dry run | Produce an exact manifest bound to actor authority, subject/tenant/org scope, source schema/head, restore epoch, policy version, record IDs, revisions/ETags, intended actions and expiry. List retained/shared records, provider tasks, holds and expected backup/version residuals. Never log field contents. |
| Approval | Fresh restricted authority plus explicit confirmation of the reviewed target/manifest digest. Changed scope, membership, version, hold or expiry invalidates it. Use separate requester/operator review for irreversible execution; confirm this operating policy with Joel. |
| Quiesce | Deny new relevant sessions/writes; inventory and drain every writer, queue, retry, import and provider callback. Obtain durable common and target ownership with fencing tokens/version checks. An in-memory mutex, UI suspension or signup-only fence is insufficient. Do not bypass a pending or retained operation. |
| Execute | Per-store transactional work where available, with durable idempotent checkpoints and before/after versions. Respect foreign keys and immutable proof; never add runtime DELETE privileges merely to get around them. Partial work stays blocked/restricted and resumable; no false all-or-nothing claim across Blob/PostgreSQL/IdP/providers. |
| Shared records | Remove only the authorised membership/person fields or organisation scope. Preserve unrelated consultant clients, co-owners and legally retained records; use reviewed minimisation or correction where deletion would destroy another party's information. |
| Verify | Check all manifest targets, active and historical versions, indexes/caches, search projections, pending delivery jobs and provider receipts. Failure to confirm a provider action is an outstanding task, not success. Recheck all boundaries before releasing writer ownership. |
| Residuals | Keep a purpose-limited minimum receipt and time-bounded holds. Report backup/version/mailbox/provider residual categories, reasons, expected expiry and responsible owner. Backups must remain access-restricted and excluded from ordinary use; avoid promising targeted purge where not supported. |
| Restore / close | Maintain a minimal suppression ledger for reapplying deletions after recovery and block reopened access until reconciliation. Its identifiers are themselves protected/retained under a defined schedule. Distinguish active-data removal, residuals pending and final verified disposal in the customer's receipt. |

Recovery is not permission to retain everything indefinitely. Define and disclose any recoverable archive period before permanent disposal. During a partial failure, resume the same operation under fresh authority and the retained durable fence; do not silently restore removed data. A backup restore requires reconciliation of tombstones, holds and deletion receipts before service resumes. The #61 `complete`/retained-intent protocol and adapted #47 checks must be preserved, not replaced with an unconditional unlock in `finally`.

Customer receipts contain case/scope, completed categories, exceptions/reasons, retained categories/expiry and escalation contact. Operator receipts contain IDs, operation/revision hashes, approvals, counts, result codes and timestamps; neither should expose raw answers, names typed for confirmation, credentials or full identity evidence in logs. Assess whether even those IDs are necessary and restrict their access.

## Qualification before any implementation is enabled

- Agree the inventory/retention/provider matrix, privacy officer process, secure delivery, acceptance wording and distinction between personal and organisation requests with Joel/legal.
- Admin owner confirms #47 archive/restore naming and guards; fence owner confirms #61 integration, stale-owner/lease-failure fixes and the expanded writer inventory. No changes to their branches or activation are made here.
- Test with synthetic records: cross-tenant denial; same email/different subject; withdrawn membership; shared consultant clients; representative authority; wrong/expired manifest; new revision; legal hold; third-party redaction; corrections attached to exports; incomplete-store refusal; archive distinct from erasure.
- Test races and faults at each store boundary: stale fence owner, lost/retained lease, concurrent assessment save, invite acceptance, queued email, export access revoked before download, crash/retry/resume, provider denial and backup restoration. Prove no resurrection, double execution or unrelated deletion; keep failed operations quarantined.
- Qualify actual provider deletion and backup expiry in an isolated environment with owner approval. Document manual tasks and residual evidence. CI success alone cannot establish deployed retention or legal readiness.

No new endpoint name, executable deletion script or environment switch is introduced by this design. Any implementation needs a separate scoped PR, tests and release-owner review; production execution would require its own explicit authorisation.
