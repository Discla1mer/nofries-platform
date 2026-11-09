# Account action endpoints

> **Extending expired access is no longer needed (10 November 2026).** Customer
> accounts do not expire: sign-in treats the stored customer-authority
> `expiresAt` as a retained, non-binding value, so there is nothing to extend.
> Suspend and restore are the only account-level blocks. The
> `extend-expired-access` endpoint below is retained, default-off, for reference
> only and should not be enabled or used to restore access; its removal belongs
> to the staff admin redesign.

`POST /api/dashboard-admin/extend-expired-access` accepts JSON:

```json
{
  "selector": { "provider": "external", "subjectKey": "<tenant UUID>:<subject UUID>", "tenantId": "<tenant>", "organisationId": "<organisation>" },
  "operationId": "<independently approved operation UUID>",
  "confirmationEmail": "<type the exact account email>",
  "newExpiresAt": "<canonical UTC ISO timestamp>"
}
```

The existing staff admin session, native session gate, scoped admin policy and
exact same-origin checks apply. The route returns 404 unless
`NOFRIES_DASHBOARD_ADMIN_ACCOUNT_ACTIONS=true`. The flag creates no authority.

Trusted composition supplies `dashboardAdministration.accountActions` alongside
the existing lookup binding: `source` (the #114 source record),
`authorityContainer`, separate `auditContainer`, and
`readApprovedExtension(operationId) -> { command, approval }` using #114's
independent approval contracts. That loader must read protected records, honor
its bounded I/O budget, and never issue an approval from request data. The native
adapter binds the approval to the current staff session, identity policy and
restore epoch. Its audit configuration digest is the canonical hash of
`{ purpose: 'dashboard_admin_account_actions', containerUrl: auditContainer.url }`.
No configured binding means no executable action. The authority SDK client must
use `retryOptions: { maxTries: 1 }`; this is checked at construction and before
the CAS. Ambiguous transport results remain uncertain even if another writer
subsequently changes the record; current bytes cannot prove an earlier outcome.

The planner from #118 limits expiry to 90 days from server time. Only active,
expired schema-1 authority records are eligible. Scheduled/schema-2 records,
including retained trials, are refused before the write to preserve revision-zero
saved-result reads. The ETag write preserves all fields
except expiry and revision; it renews no memberships, entitlements or terms.
Existing retained-trial revision-zero checks remain intact.

Append-only `dashboard-admin-account-actions/<operationId>/attempt.json` and
`terminal.json` records retain the actor, target digest, before/proposed/after
expiry, timestamps and outcome. A missing terminal record or `uncertain`
outcome requires reconciliation against the current authority and approved
command; do not retry with a new operation ID blindly. Success is returned only
after durable terminal audit. No endpoint deletes data or enables itself.

## Approving an extension in /operator

With the same flag and scoped staff-admin binding, omit `readApprovedExtension`
from the trusted action configuration to use the built-in protected approval
store in `auditContainer`. No additional dependency or externally issued
approval is needed. The container must already exist with restricted access;
the application does not create it or change permissions.

Joel selects a scoped account from lookup, types its email, chooses an expiry,
and clicks **Approve extension**. This opens his native operator session if
needed. `POST /api/dashboard-admin/approve-extension` accepts
`{ selector, confirmationEmail, newExpiresAt }`. It checks scoped authorization
before reading the exact subject record, then uses the existing planner to issue
a session/epoch/ETag-bound 15-minute approval. Missing, forbidden and ineligible
targets return the same refusal. Audit target digests hash the selector, not email.
Lookup includes selectors only with the actions flag; selection is cleared on
new lookup, input or page navigation.

Only an approval with matching durable `approval-terminal.json` success audit
can be read by the executor. **Extend access** submits its returned selector
and operation ID. The create-only action `attempt.json` consumes that operation
once, including on failure; approvals never bypass current authority or CAS.
Changing the form clears its approval. No customer authority changes on approval.

The final native recheck and the Azure conditional write use separate stores.
Session/approval revocation can race that small interval; ETag fencing protects
subject-record changes, not native revocation. This remains a documented limit
of the default-off expiry action; strict cross-store revocation fencing needs a
separate design. The PostgreSQL membership action uses transaction fences.

`POST /api/dashboard-admin/suspend` and `POST /api/dashboard-admin/restore`
use the same flag and HTTP guards. Their JSON bodies contain `selector`,
`operationId`, `confirmationEmail`, and `expectedMembershipRevision` from the
scoped authority lookup (not the customer-subject revision). Only that membership
changes. Sign-in and other organisations remain available; restoration does not
renew an expired membership or authority.

`POST /api/dashboard-admin/approve-suspend` and `approve-restore` accept the same
body without `operationId` and return a server-issued operation ID. They verify
typed email and current membership revision, then durably audit a 15-minute
approval in the protected store. Configure `auditPolicy`; omit `readApprovedAction`
to use this issuer/reader. Execution always verifies the protected issuance audit.
An optional custom reader can additionally revoke approval and must return the same closed wrapper,
binding the #109 grant to one operation, session digest, exact target/revision,
subject-record digest, source and audit destination. Bare reusable grants fail.
The operator cannot suspend their own membership. Restore requires a successful
staff suspend audit plus its native receipt. Up to 100 intervening revisions
must be verified actions on other members; unknown or same-member changes refuse.
Native session,
restore epoch, approval and subject authority are rechecked before SQL writes
and COMMIT. The existing canonical repository checks revisions and preserves
operation receipts; no new SQL permissions or schema are installed. Nested native
checks reuse the current connection through read-only savepoints, restoring its
role, tenant and timeout settings. This also supports a pool maximum of one.
