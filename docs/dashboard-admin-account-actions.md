# Account action endpoints

Suspend and restore are the only account actions. Customer accounts do not expire, so there is no extension endpoint. Settings and roles are in [the staff admin guide](staff-admin.md).

All four routes are `POST`, same-origin JSON, and return 404 unless `NOFRIES_DASHBOARD_ADMIN_ACCOUNT_ACTIONS=true`. They require the staff admin session and native operator session described in the guide.

`/api/dashboard-admin/approve-suspend` and `/approve-restore` accept `{ selector, confirmationEmail, expectedMembershipRevision }`. `selector` is `{ provider, subjectKey, tenantId, organisationId }` from the email lookup; `expectedMembershipRevision` comes from the dashboard access read, not the sign-in record's revision. They check the typed email against the customer's sign-in record and the current membership, then store a 15-minute approval bound to the staff session, target, revision and one server-issued operation ID, which they return.

`/api/dashboard-admin/suspend` and `/restore` accept the same body plus that `operationId`. Only that membership changes. Sign-in and other organisations are unaffected, and restoring does not renew an expired membership. A staff admin cannot suspend their own membership. Restore requires a successful staff suspension with its matching database receipt; up to 100 later membership changes are accepted only if each is a verified staff action on another member.

The native session, restore epoch, approval and sign-in record are rechecked before the SQL write and before COMMIT, inside advisory locks taken at the start of the transaction. An approval or operation is used once, including on failure.

Create-only records under `dashboard-admin-account-actions/<operationId>/` in the audit container hold the approval (`approval-attempt.json`, `approval.json`, `approval-terminal.json`) and the action (`attempt.json`, `terminal.json`): actor, target digest, before and after status, timestamps and outcome. Success is returned only after the terminal record is stored. A missing terminal record or an `uncertain` outcome means the result must be checked against the current membership before trying again with a new approval. No endpoint deletes data.
