# Account action endpoints

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

Joel enters the account email, types it again, selects an expiry, and chooses
**Approve extension**. This explicitly opens his native operator session if
needed. `POST /api/dashboard-admin/approve-extension` accepts
`{ email, confirmationEmail, newExpiresAt }`. It resolves exactly one record in
the configured source (at most 100 subjects), checks scoped authorization and
the existing planner, then issues a session/epoch/ETag-bound 15-minute approval.
Multiple matches, incomplete scans and malformed records fail closed.

Only an approval with matching durable `approval-terminal.json` success audit
can be read by the executor. **Extend access** submits its returned selector
and operation ID. The create-only action `attempt.json` consumes that operation
once, including on failure; approvals never bypass current authority or CAS.
Changing the form clears its approval. No customer authority changes on approval.
