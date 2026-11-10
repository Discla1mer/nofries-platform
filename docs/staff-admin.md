# Staff admin console

The staff console lives at `/operator`. A staff admin can look up any customer by email, read that customer's dashboard membership, and suspend or restore it. Nothing in the console deletes customer data or changes a customer's sign-in record. Everything is off until the settings below are set.

## Who can use it

A request is accepted only when all of these hold:

- signed in through the workforce (Entra) staff login;
- the subject is in `NOFRIES_ALLOWED_SUBJECTS` and `NOFRIES_ADMIN_SUBJECTS`;
- the native operator session is open (the console opens it on first use), its issuance proof is intact and the restore epoch is current.

There is no per-customer approval record, locator or publication step.

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

If a setting is unusable the app still starts; it logs one line (`[dashboard-admin] dashboard_admin_configuration_invalid`, or `[dashboard-admin-account-actions] dashboard_admin_unavailable` when only the action settings are wrong) and leaves that part off.

## Turn it off

Set `NOFRIES_STAFF_CONSOLE=false` to turn the whole console off. Set `NOFRIES_DASHBOARD_ADMIN_ACCOUNT_ACTIONS=false` to keep lookup but remove suspend and restore. Setting `NOFRIES_DASHBOARD_ADMIN_ACCOUNT_LOOKUP=false` also turns the whole console off. Audit records are kept.

## What it does

**Look up by email.** The email travels only in the same-origin request body. Every configured store is searched. Each store's scan stops at 100 sign-in records; the page says when that cap was reached, and a starter account found by email is still shown with its sign-in record marked as not scanned. Rows show the store, schema, plan, account type, organisation, sign-in record status, activation time, recorded end date (not enforced: accounts do not expire) and revision. Each authorised lookup writes one record under `dashboard-admin-account-lookups/` in the audit container holding digests, status and counts only; if that write fails the lookup is refused.

**Show dashboard access.** Reads one customer's membership in one organisation from PostgreSQL, with an attempt and an outcome audit row in the database.

**Suspend or restore.** Type the account email to approve, then apply within 15 minutes. The approval is bound to the staff session, the customer, the membership revision that was read and one operation. Suspension blocks only that organisation's dashboard membership; restore needs the matching staff suspension on record. Each approval and each action writes an attempt record and an outcome record under `dashboard-admin-account-actions/<operation>/`; success is reported only after the outcome record is stored. If the page says the outcome could not be confirmed, read dashboard access again before retrying.

## If a restore is refused after a suspension that did happen

A suspension is committed in the database before its outcome record is written. If that final audit write fails (storage outage at that moment), the page reports that the outcome could not be confirmed, the membership **is** suspended, and the operation's `terminal.json` says `"outcome": "uncertain"` instead of `succeeded`.

Restore deliberately trusts only suspensions with a `succeeded` outcome record that matches the database receipt. So from then on every restore for that organisation is refused with a conflict (HTTP 409, "Request refused" in the console), for that member and for any other member whose restore check has to walk back past that operation.

How to recognise it: dashboard access shows the membership as suspended; restore keeps being refused although the email and revision are right; and in the audit container `dashboard-admin-account-actions/<operationId>/terminal.json` for the suspension has outcome `uncertain` (or is missing) while `attempt.json` exists.

There is no button for this and the check is not relaxed in code. Recovery is a manual, reviewed fix by the owner: confirm from the database operation receipt that the suspension committed, then either correct the membership directly through the database maintenance procedure or repair the audit evidence under the audit policy. Record what was done and why.

Signup listing (`NOFRIES_DASHBOARD_ADMIN_ENABLED`, `NOFRIES_DASHBOARD_ADMIN_BINDING`) is a separate feature and is not needed for any of the above.
