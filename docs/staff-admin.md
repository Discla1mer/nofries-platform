# Staff admin console

The staff console lives at `/operator`. A staff admin can look up any customer by email, read that customer's dashboard membership, and suspend or restore it. With its own flag on, the console can also reset or delete one account (see [Reset and delete](#reset-and-delete)); nothing else in the console deletes customer data or changes a customer's sign-in record. Everything is off until the settings below are set.

## Who can use it

A request is accepted only when all of these hold:

- signed in through the workforce (Entra) staff login;
- the subject is in `NOFRIES_ALLOWED_SUBJECTS` and `NOFRIES_ADMIN_SUBJECTS`;
- the native operator session is open (the console opens it on first use), its issuance proof is intact and the restore epoch is current.

There is no per-customer approval record, locator or publication step.

### Accepted risk: the admin can act on any customer

By design, the sole allowlisted staff admin can look up, suspend, restore, reset and delete any customer account. No second person approves, and there is no per-customer grant. This is an owner decision (19 Nov 2026; security PR #474 was closed as by design). Every approval is self-issued by the acting admin, and its records say so: `approvalAuthority: "self_issued_sole_admin"` (suspend/restore approval and action records; the reset/delete `approval.json`). The field is a label only and grants nothing. Records written before it was added do not have it.

The protections that remain:

- Only the workforce staff sign-in with the subject in both `NOFRIES_ALLOWED_SUBJECTS` and `NOFRIES_ADMIN_SUBJECTS`, a current native operator session, same-origin requests and the request budget.
- Each action needs its own approval: the admin types the exact customer email (and `RESET` or `DELETE` for those actions).
- An approval lasts 15 minutes, is bound to the admin, their browser session, the exact customer and the one action, and is used once.
- Suspend/restore approvals are also bound to the membership revision that was read. Reset/delete approvals are bound to the account id, store and sign-in subject seen at approval.
- Every approval, attempt, outcome and refusal is written create-only to the audit container. If the approval or attempt record cannot be written, nothing runs.
- A staff admin cannot suspend their own membership. Restore needs a matching recorded staff suspension.

## Turn it on

Set these App Service settings (exact values):

| Setting | Value |
| --- | --- |
| `NOFRIES_STAFF_CONSOLE` | `true` |
| `NOFRIES_DASHBOARD_ADMIN_ACCOUNT_LOOKUP` | `true` |
| `NOFRIES_DASHBOARD_ADMIN_AUDIT_CONTAINER` | The private audit container on `AZURE_STORAGE_ACCOUNT_NAME` |
| `NOFRIES_DASHBOARD_ADMIN_ACCOUNT_ACTIONS` | `true` to allow suspend and restore; leave unset for read-only |

The console also uses settings that already exist: `AZURE_STORAGE_ACCOUNT_NAME`, `NOFRIES_CUSTOMER_AUTHORITY_CONTAINER`, `NOFRIES_STARTER_AUTHORITY_CONTAINER`, `NOFRIES_EXTERNAL_CUSTOMER_AUTHORITY_CONTAINER` (with `NOFRIES_EXTERNAL_CUSTOMER_TENANT_ID`), `NOFRIES_SCOPE_SIGNING_SECRET`, the native dashboard runtime settings and, when a user-assigned identity is used, `NOFRIES_MANAGED_IDENTITY_CLIENT_ID`. Lookup works with at least one customer container; suspend and restore need all three.

Grant the App Service managed identity these data-plane roles, each scoped to the one container:

| Container | Role |
| --- | --- |
| `NOFRIES_CUSTOMER_AUTHORITY_CONTAINER` | Storage Blob Data Reader |
| `NOFRIES_STARTER_AUTHORITY_CONTAINER` | Storage Blob Data Reader |
| `NOFRIES_EXTERNAL_CUSTOMER_AUTHORITY_CONTAINER` | Storage Blob Data Reader |
| `NOFRIES_DASHBOARD_ADMIN_AUDIT_CONTAINER` | Storage Blob Data Contributor |

Do not lower a role another feature already needs on the same container (signup writes to the starter containers). The existing session, proof and epoch container roles and the PostgreSQL runtime role are unchanged.

If a setting is unusable the app still starts and leaves that part off, logging one line:

| Log line | Meaning |
| --- | --- |
| `[dashboard-admin] dashboard_admin_configuration_invalid` | A console setting above is missing or malformed; the whole console is off. |
| `[dashboard-admin-account-actions] dashboard_admin_unavailable` | Only the suspend/restore settings are unusable (for example a customer container is missing); lookup still works. |
| `[dashboard-admin-listing] dashboard_admin_binding_invalid` | `NOFRIES_DASHBOARD_ADMIN_BINDING` or `NOFRIES_DASHBOARD_ADMIN_ENABLED` is unusable; signup listing is off. The console is not affected. |

One exception is outside the console: if customer signup is enabled and `NOFRIES_DASHBOARD_ADMIN_BINDING` is set but malformed, the app does not start, rather than accept untracked account writes. Remove or correct the locator before deploying.

## Turn it off

Set `NOFRIES_STAFF_CONSOLE=false` to turn the whole console off. Set `NOFRIES_DASHBOARD_ADMIN_ACCOUNT_ACTIONS=false` to keep lookup but remove suspend and restore. Setting `NOFRIES_DASHBOARD_ADMIN_ACCOUNT_LOOKUP=false` also turns the whole console off. Audit records are kept.

## What it does

**Signups.** "Load signups" lists every account in the starter stores (legacy and external), newest first, capped at 200. Each row shows the email, account type, when the account was formed, whether signup was finished (and when it was activated), the state of the sign-in record, the plan and the organisation names, clients included for consultants. It is the lookup route called with an empty body `{}`, so it uses the same staff authority, budget and audit: each list writes one record under `dashboard-admin-account-lookups/` with category `dashboard_admin_account_list` and no target. "Open" runs the email lookup below for that account. Accounts held only in the legacy admin store are not listed; use lookup by email for those.

**Look up by email.** The email travels only in the same-origin request body. Every configured store is searched. Each store's scan stops at 100 sign-in records; the page says when that cap was reached, and a starter account found by email is still shown with its sign-in record marked as not scanned. Rows show the store, schema, plan, account type, organisation, sign-in record status, activation time, recorded end date (not enforced: accounts do not expire) and revision. Each authorised lookup writes one record under `dashboard-admin-account-lookups/` in the audit container holding digests, status and counts only; if that write fails the lookup is refused.

**Show dashboard access.** Reads one customer's membership in one organisation from PostgreSQL, with an attempt and an outcome audit row in the database.

**Suspend or restore.** Type the account email to approve, then apply within 15 minutes. The approval is bound to the staff session, the customer, the membership revision that was read and one operation. Suspension blocks only that organisation's dashboard membership; restore needs the matching staff suspension on record. Each approval and each action writes an attempt record and an outcome record under `dashboard-admin-account-actions/<operation>/`; success is reported only after the outcome record is stored. If the page says the outcome could not be confirmed, read dashboard access again before retrying.

To stop a customer's access, suspend the membership. Accounts do not expire, and if two dashboard product grants already stored for an organisation share a start date, suspending one of them does not stop access.

**Contact requests.** With `NOFRIES_OPERATOR_CONTACT_REQUESTS_ENABLED=true` (exact value; anything else leaves it off), the console shows a read-only Contact requests panel: dashboard contact requests from the last 90 days, newest first, capped at 200, with the NZ date and time, organisation name, topic and a contact email. The email is the requesting customer's own account email when that sign-in belongs to a listed account; otherwise it is the email of the account that owns the organisation, and the page says so. "Load contact requests" sends the body `{"contactRequests":true}` to the same lookup route, with the same staff checks and budget, and writes one lookup record with category `dashboard_admin_contact_request_list` and no target. Organisations come from the signup list (newest 200 accounts), so requests in older accounts are not shown; when the cap is reached or an account or its client list could not be read in full, the page says the list may be incomplete. Rows are read with the existing runtime database role, one organisation's tenant setting at a time, in a read-only transaction: no migration, grant or new role. Nothing can be edited or deleted here. If the setting is on but unusable, the app logs `[dashboard-admin-contact-requests] dashboard_admin_unavailable` and only this panel stays off.

## If a restore is refused after a suspension that did happen

A suspension is committed in the database before its outcome record is written. If that final audit write fails (storage outage at that moment), the page reports that the outcome could not be confirmed, the membership **is** suspended, and the operation's `terminal.json` says `"outcome": "uncertain"` instead of `succeeded`.

Restore deliberately trusts only suspensions with a `succeeded` outcome record that matches the database receipt. So from then on every restore for that organisation is refused with a conflict (HTTP 409, "Request refused" in the console), for that member and for any other member whose restore check has to walk back past that operation.

How to recognise it: dashboard access shows the membership as suspended; restore keeps being refused although the email and revision are right; and in the audit container `dashboard-admin-account-actions/<operationId>/terminal.json` for the suspension has outcome `uncertain` (or is missing) while `attempt.json` exists.

There is no button for this and the check is not relaxed in code. Recovery is a manual, reviewed fix by the owner: confirm from the database operation receipt that the suspension committed, then either correct the membership directly through the database maintenance procedure or repair the audit evidence under the audit policy. Record what was done and why.

Signup listing (`NOFRIES_DASHBOARD_ADMIN_ENABLED`, `NOFRIES_DASHBOARD_ADMIN_BINDING`) is a separate feature and is not needed for any of the above.

## Reset and delete

Next to suspend, the console offers two more account actions, one account at a time:

- **Reset** clears the account's assessments, evidence, improvement plans and contact requests in every organisation it owns (clients included). Sign-in, email and organisations are kept, so the customer can sign in and start again. Only the database changes: the Blob records hold no assessment, evidence or plan data.
- **Delete** removes the account completely, in this order: the database rows, then the Blob records (account, organisation, client, sign-in authority and email-proof records, with their stored versions), then the customer's Microsoft Entra External ID user. That user is also permanently removed from deleted items, so it cannot be restored.

### How staff use it

Select the account, choose Reset or Delete, then type the account email and the word `RESET` or `DELETE` to approve. The approval is held on the server, bound to your staff sign-in and browser session, lasts 15 minutes and can be used once. Apply to carry it out.

Some accounts cannot be selected in lookup: a delete that stopped after its stored records were removed leaves no rows, and a row found past the 100-record scan cap has no selector. For these, enter the email under **Reset or delete by email**, choose Reset or Delete, then approve and apply as usual. The page sends only the email; the server resolves the account itself, still needs the typed email and word, and records approvals and refusals the same way. To finish a partial delete, the server uses only the retry reference it kept (see Outcomes) and never accepts an identity id from the page.

The actions go through the existing `POST /api/dashboard-admin/accounts/lookup` route as a body with the single key `wipe`, so the Static Web Apps route table does not grow. They have the same staff, native session, same-origin and rate checks as lookup. Applying is handled like suspend and restore: the response waits for the outcome and its audit record, instead of the 10-second read budget. One 25-second budget covers the whole apply: the attempt record, the database, storage and identity stages, and the outcome record (the last 3 seconds are kept for it). That keeps the reply well inside the Static Web Apps edge timeout (about 45 seconds). Once a run has started it continues to the end of that budget, even if the browser is closed. The budget is enforced inside the database transaction too: each statement's `statement_timeout` and the lock wait are capped at the time left, the time left is checked again just before `COMMIT`, and nothing is committed after it. A delete still unfinished at that point stops as `partial`; finish it by approving and applying again. If the page itself gives up waiting (70 seconds), it says the outcome could not be confirmed.

Before anything irreversible, Delete obtains a Microsoft Graph token for the External ID tenant and checks its tenant and audience, at approval and again at apply. A broken Graph credential is therefore refused (`account_wipe_identity_unavailable`) with nothing changed, instead of being found after the database and Blob records are gone.

**One app instance is assumed.** Approvals and retry references are held in the memory of the app instance that issued them. With more than one instance, an apply that lands on another instance is refused (`account_wipe_approval_invalid`) and has to be approved again. A retry reference held only in memory is lost the same way; the durable retry marker below still covers the database part. Scaling out needs a shared approval store first.

### Outcomes

Each approval writes `dashboard-admin-account-wipes/<operationId>/approval.json` in the audit container. Each apply writes `attempt.json` before anything changes and `outcome.json` afterwards. Every refused approval or apply writes `approval_refused.json` or `execute_refused.json` under its own id, with the code. That includes a wrong typed email or word, an expired or used approval, no account found, busy, a missing role and a malformed request. Records hold the staff digest, the keyed email digest (the same as lookup records), stage names, a code and counts. They never hold the email, the sign-in subject or any record content. If the attempt record cannot be written, nothing runs. If the outcome record cannot be written, the console says so and the app logs `[dashboard-admin-account-wipe] outcome_unrecorded <operationId>` (no personal data).

| Outcome | Meaning |
| --- | --- |
| `succeeded` | Every stage is done (or was already gone). |
| `refused` | Nothing changed. The code says why (see below). |
| `timed_out_rolled_back` | The run budget ran out inside the database transaction. It was rolled back, so nothing was committed. Approve and apply again. |
| `unknown` | The database `COMMIT` was sent but its result is not known (connection lost or cancelled during it). The change may or may not have been applied. Look the account up before retrying. A delete retry converges: if it did commit, the database stage reports `absent` and the rest is finished. |
| `partial` | Delete only. The database part is done and a later stage (`storage` or `identity`) failed. Approve and apply Delete again: completed stages report `absent` and the rest is finished. |

Before the first delete, the app takes a retry reference: the sign-in subject and, once the database part is done, that fact. Both stay in app memory for 7 days. The database-done fact is also written as `dashboard-admin-account-wipes/retry/<email digest>.json` in the audit container. That file holds digests only and is trusted only for the same account. With it, an unactivated account whose subject was recorded only in an organisation context that storage has since deleted can still be finished after a restart. A partial delete that stopped at the identity stage can likewise still remove the External ID user from memory. If the app restarts before the retry, the retry reports `account_wipe_identity_reference_lost`. In that case, delete the user by hand in the Entra admin centre (External ID tenant, Users, search by the email, then delete it and permanently delete it from Deleted users).

Accounts in the legacy (workforce) starter store have no External ID user. Their identity stage is `not_applicable`.

### Refusals

| Code | Meaning |
| --- | --- |
| `account_wipe_legacy_index_configured` | Delete is off while the legacy signup listing (`NOFRIES_DASHBOARD_ADMIN_ENABLED` / `NOFRIES_DASHBOARD_ADMIN_BINDING`) is configured, because its published index is not deletion-aware. Reset is unaffected. |
| `account_wipe_identity_not_configured` | Delete needs the Graph settings below. It is refused before anything is touched. |
| `account_wipe_role_unavailable` | The app's database login cannot `SET ROLE nofries_account_wipe`. |
| `account_wipe_reference_blocked` | A session the wipe cannot see still references the account: a staff `operator_dashboard` session, or another person's customer session in a consultant's client organisation. End it and retry. |
| `account_wipe_target_changed` | The account found at apply is not the one approved (for example it was deleted and signed up again with the same email). Nothing changed. Look it up and approve again. Approvals are bound to the account id, store and sign-in subject seen at approval, and a run that changes anything voids every other approval for that email. |
| `account_wipe_subject_mismatch` | The database still holds rows of this account (its email preferences, or rows in its organisations) but not under the sign-in subject the stored records name. Nothing changed. This needs investigation before a delete. |
| `account_wipe_identity_unavailable` | No valid Graph token for the External ID tenant (credential, federation or consent broken). Delete is refused before anything is touched; reset is unaffected. |
| `account_wipe_identity_pending` | (Partial, identity stage.) The user was deleted but had not yet appeared in deleted items after a short bounded retry. Approve and apply Delete again to remove it permanently. |
| `account_wipe_tenant_mismatch` | One of the account's organisations is not linked to it in the database (for example a client that was never set up). Nothing changed. |
| `account_wipe_subject_unknown` | The account has no recorded sign-in subject (a signup that was never finished) and the database still holds some of it, or the action is Reset. Delete removes an unfinished signup only when a read-only check finds nothing of it in the database: its stored records go, the database stage is `absent` and the sign-in stage is `none_recorded`. If an External ID user was created for it anyway, remove that user in the Entra admin centre. |
| `account_wipe_account_not_found` / `account_wipe_account_ambiguous` | No account for that email, or the email is in both starter stores and no store was named. Reset and Delete from the Customer accounts list name the row's store (`store`: `legacy` or `external`), so only that account is acted on. |
| `account_wipe_busy` | A customer save held a table past the 5-second lock timeout, or another wipe of the same account is running. Try again. |

`account_wipe_role_unavailable`, `account_wipe_identity_not_configured` and `account_wipe_identity_unavailable` are service faults and are answered with HTTP 503; the other refusals with 400, 403, 404 or 409.

### Turn it on (production steps, in order)

All of these are owner steps. Reset needs steps 1 and 5 only.

1. **Database.** Apply migration `0025_account_wipe_role.sql`. Then grant the role to the app's runtime database login, with `SET` and without `INHERIT`: `GRANT nofries_account_wipe TO "<runtime login>" WITH SET TRUE, INHERIT FALSE;`. The app runs `SET LOCAL ROLE nofries_account_wipe` only inside a wipe transaction and checks `pg_has_role(current_user, 'nofries_account_wipe', 'SET')` before each approval and each run.
2. **Storage.** Give the App Service managed identity **Storage Blob Data Contributor** on `NOFRIES_STARTER_AUTHORITY_CONTAINER`, on `NOFRIES_EXTERNAL_CUSTOMER_AUTHORITY_CONTAINER`, and on the browser-auth container (`NOFRIES_BROWSER_AUTH_CONTAINER` on `NOFRIES_BROWSER_AUTH_STORAGE_ACCOUNT`, which holds the email proofs). Each grant is scoped to its container. Where blob versioning is on, the identity also needs `Microsoft.Storage/storageAccounts/blobServices/containers/blobs/deleteBlobVersion/action` on those containers. Contributor does not include it: use a custom role with that one data action, or Storage Blob Data Owner. Without it, delete reports `partial` at the storage stage (`account_wipe_storage_incomplete`).
3. **Graph app.** In the **workforce tenant** (the tenant that holds the App Service managed identity), register an app and make it multi-tenant. Give it the Microsoft Graph **application** permissions `User.ReadWrite.All` and `User.DeleteRestore.All`. Then grant admin consent **in the External ID tenant** with the admin-consent link (`https://login.microsoftonline.com/<External ID tenant id>/adminconsent?client_id=<app client id>`), so the app gets a service principal there. Do not register the app in the External ID tenant: Entra does not let an app trust a managed identity from another tenant, so the federated credential in step 4 would never work.
4. **Federated credential.** On that app, add a federated identity credential that trusts the App Service managed identity: issuer `https://login.microsoftonline.com/<workforce tenant id>/v2.0`, subject the managed identity's object (principal) id, audience `api://AzureADTokenExchange`. No client secret is created.
5. **Settings.**

| Setting | Value |
| --- | --- |
| `NOFRIES_ACCOUNT_WIPE_GRAPH_TENANT_ID` | The External ID tenant id. It must equal `NOFRIES_EXTERNAL_CUSTOMER_TENANT_ID`. |
| `NOFRIES_ACCOUNT_WIPE_GRAPH_CLIENT_ID` | The app registration's client id from step 3. |
| `NOFRIES_DASHBOARD_ADMIN_ACCOUNT_WIPE` | `true`, last. Any other value leaves it off. |

The feature also needs `NOFRIES_DASHBOARD_ADMIN_ACCOUNT_ACTIONS=true` and the console settings above. When `NOFRIES_MANAGED_IDENTITY_CLIENT_ID` is set, the Graph assertion uses that same identity.

Log lines:

| Log line | Meaning |
| --- | --- |
| `[dashboard-admin-account-wipe] dashboard_admin_unavailable` | The flag or a wipe port is unusable. Reset and delete are off; lookup, suspend and restore keep working. |
| `[dashboard-admin-account-wipe] account_wipe_identity_configuration_invalid` | Only one Graph setting is set, a setting is malformed, or the tenant is not the External ID tenant. Delete is refused; reset works. |

To turn it off, unset `NOFRIES_DASHBOARD_ADMIN_ACCOUNT_WIPE` (or set it to `false`). The lookup route then answers a `wipe` body with 404 and the console hides the controls. Audit records are kept.

### What the database part does

- `nofries_account_wipe` is a NOLOGIN role with only SELECT and DELETE. Its row-level policies see one tenant, account and subject at a time, named in transaction-local settings (`nofries.wipe_tenant_id`, `nofries.wipe_account_id`, `nofries.wipe_subject_key`). It can never insert or update.
- The repository checks that the account exists under that subject and that every tenant belongs to the account. It then deletes children before parents and commits once. Any error rolls everything back.
- Session-anchored runtime rows are removed only where they carry no tenant. A session row in an organisation the account does not own makes the delete fail rather than reach across.

### Retention after a delete

- Database backups and point-in-time restore keep the data until their retention expires.
- Blob container soft delete, where enabled, keeps deleted blobs for its retention period.
- Email proofs from earlier invitations, and the customer's browser-session blobs, are not looked up. They expire on their own.
- The External ID user is deleted and then permanently removed from deleted items, so it is not restorable.
