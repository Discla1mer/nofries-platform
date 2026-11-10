# Production dashboard administration

Owner runbook for nofries.nz, [#45](https://github.com/Discla1mer/nofries-platform/issues/45). Deploy the reviewed PR through the existing release controller first. This repository and its CI do not apply Azure changes. The commands below are for the release owner's approved workstation, not GitHub Actions. They contain no secret values; keep shell tracing off and retain plans privately.

## Staff console (current lookup procedure)

Account lookup no longer uses a per-customer approval record. `NOFRIES_DASHBOARD_ADMIN_LOOKUP_AUTHORITY_CONTAINER` is not read any more, and the approval publication tool below is not needed for lookup. Wherever this page still mentions approval records for lookup or `scripts/dashboard-admin-approve.js`, treat it as superseded by this section; a short replacement guide follows with the clean-up change.

The read-only console is composed when **all** of these are set on the App Service (exact values, default off):

| Setting | Value |
| --- | --- |
| `NOFRIES_STAFF_CONSOLE` | `true` |
| `NOFRIES_DASHBOARD_ADMIN_ACCOUNT_LOOKUP` | `true` (setting it `false` turns off email and selector lookup) |
| `NOFRIES_DASHBOARD_ADMIN_AUDIT_CONTAINER` | Existing private container on `AZURE_STORAGE_ACCOUNT_NAME`, different from every authority, session, proof and epoch container |
| `NOFRIES_CUSTOMER_AUTHORITY_CONTAINER`, `NOFRIES_STARTER_AUTHORITY_CONTAINER`, `NOFRIES_EXTERNAL_CUSTOMER_AUTHORITY_CONTAINER` | The existing customer stores (at least one; `NOFRIES_EXTERNAL_CUSTOMER_TENANT_ID` is needed with the external one) |

The existing workforce sign-in, `NOFRIES_ALLOWED_SUBJECTS`/`NOFRIES_ADMIN_SUBJECTS`, native dashboard runtime, `NOFRIES_SCOPE_SIGNING_SECRET` and `NOFRIES_MANAGED_IDENTITY_CLIENT_ID` settings in the table below still apply. `NOFRIES_DASHBOARD_ADMIN_ENABLED` and `NOFRIES_DASHBOARD_ADMIN_BINDING` are for signup listing only and are not needed.

The App Service managed identity needs these data-plane roles, each scoped to the named container:

| Container | Role |
| --- | --- |
| Each configured customer authority container (three settings above) | Storage Blob Data Reader |
| `NOFRIES_DASHBOARD_ADMIN_AUDIT_CONTAINER` | Storage Blob Data Contributor (create-only lookup audit records) |

Staff authority is the allowlisted admin subject, the native operator session gate, its issuance proof and the restore epoch. Email lookup and the selector lookup (`POST /api/dashboard-admin/lookup`) are approval-free reads by design; each authorised email lookup writes one digest-only audit record and is refused if that write fails. Unusable settings log one line (`[dashboard-admin] dashboard_admin_configuration_invalid`) and leave the console off without stopping the app. To disable, set `NOFRIES_STAFF_CONSOLE=false`.

## Stop points and durable changes

* **Reversible:** the new locator, enable flags and RBAC assignments. Set `NOFRIES_DASHBOARD_ADMIN_ENABLED=false` to disable this environment composition. Disable `NOFRIES_DASHBOARD_ADMIN_ACCOUNT_LOOKUP` too if you want lookup routes to return 404 instead of unavailable.
* **Durable:** publication writes an immutable intent and approval revision before conditionally advancing the head. Do not delete history to undo approval. Publish a higher, revoked revision; an expired approval is also denied. Partial writes may remain after failure. An intent proves an attempted publication, not successful completion.
* **One-way adoption — NOT part of the lookup checklist:** setting `NOFRIES_DASHBOARD_ADMIN_BINDING` wraps customer account writers even when `NOFRIES_DASHBOARD_ADMIN_ENABLED=false`. The writer journal must already be initialized; otherwise new account writes fail closed. Once adopted, retain that locator through UI disable and rollback. Removing it permits untracked writes and invalidates listing completeness. Do not rename its provider/population/index/source or restore old heads as a rollback shortcut.
* **Restore/instance operations:** never rotate the instance UUID or restore epoch to repair an admin 503. Epoch changes revoke sessions/approvals and require the existing fenced recovery procedure. PostgreSQL bootstrap, migrations and ingress changes belong to the database/release owner, not this approval tool. Existing production customer admission should already have these foundations.

## Settings: exact contracts

UUID means canonical lower-case `8-4-4-4-12` hexadecimal; subject means `<identity-tenant-uuid>:<user-object-uuid>`, never email. An ID is a nonempty, trimmed string of at most 180 characters, with no controls or `*`. Revisions are nonnegative safe integers (environment representation: decimal digits, no leading zero except `0`). Timestamps are UTC `YYYY-MM-DDTHH:mm:ss.sssZ`. Storage account names are 3–24 lowercase alphanumerics; container names are 3–63 lowercase alphanumerics/hyphens, no adjacent hyphens, alphanumeric ends.

| Setting | Required value / purpose |
| --- | --- |
| `NOFRIES_DASHBOARD_ADMIN_ENABLED` | Exact `true` to select environment administration; unset/empty/`false` disables it. |
| `NOFRIES_DASHBOARD_ADMIN_LOOKUP_AUTHORITY_CONTAINER` | **Superseded; no longer read.** See the staff console section above. |
| `NOFRIES_DASHBOARD_ADMIN_ACCOUNT_LOOKUP` | Exact `true`, together with `NOFRIES_STAFF_CONSOLE=true`, exposes the read-only lookups. Otherwise off. |
| `NOFRIES_DASHBOARD_ADMIN_BINDING` | **Unset for this procedure.** Optional listing JSON contract below; not an administrator grant. |
| `NOFRIES_DASHBOARD_RUNTIME_ENABLED` | Exact `true`; otherwise no native dashboard composition. |
| `NOFRIES_DASHBOARD_INSTANCE_ID` | Existing runtime instance UUID; must match PostgreSQL, epoch blob and approval. |
| `NOFRIES_DASHBOARD_IDENTITY_POLICY_ID`, `NOFRIES_DASHBOARD_IDENTITY_POLICY_REVISION` | Existing workforce policy ID and revision; copy these into the approval's `identityPolicy`. |
| `NOFRIES_ENTRA_TENANT_ID`, `NOFRIES_ENTRA_CLIENT_ID` | Workforce tenant UUID and staff web-app client UUID. The Entra web redirect URI is `https://nofries.nz/api/auth/callback`. Customer/external tenant IDs must not replace these. |
| `NOFRIES_ALLOWED_SUBJECTS`, `NOFRIES_ADMIN_SUBJECTS` | For the sole staff admin, exactly Joel's workforce `tid:oid` in both. Lists accept comma/semicolon/newline separators; do not use email-based admin settings or enable tenant-wide access. |
| `NODE_ENV`, `NOFRIES_REQUIRE_AUTH`, `NOFRIES_BROWSER_AUTH_MODE`, `NOFRIES_TRUSTED_AUTH_PROXY` | `production`, `true`, `entra_bff`, `false`, respectively. SWA roles/headers do not substitute for BFF/native authority. |
| `NOFRIES_PUBLIC_URL` | `https://nofries.nz`; lookup requires this exact Origin plus `Sec-Fetch-Site: same-origin`. |
| `NOFRIES_BROWSER_SESSION_STORE` | `azure`. |
| `NOFRIES_BROWSER_AUTH_STORAGE_ACCOUNT`, `NOFRIES_BROWSER_AUTH_CONTAINER` | Dedicated auth account; container defaults to `nofries-browser-auth`. Must differ from application-data account. |
| `AZURE_STORAGE_ACCOUNT_NAME` | Existing application-data account. Hosts the new approval container and configured customer authority containers. |
| `NOFRIES_DASHBOARD_PROOF_CONTAINER`, `NOFRIES_DASHBOARD_EPOCH_CONTAINER` | Existing containers in the auth account; distinct from each other and session container. |
| `NOFRIES_MANAGED_IDENTITY_CLIENT_ID` | Unset/empty for system-assigned identity; otherwise the assigned user-managed identity's **client UUID**, not its principal/object UUID. |
| `NOFRIES_POSTGRES_HOST` | Existing `<server>.postgres.database.azure.com`; TLS verification stays enabled. |
| `NOFRIES_POSTGRES_DATABASE`, `NOFRIES_POSTGRES_USER` | Existing database and Entra database principal names; 1–128 characters in `[A-Za-z0-9_.@-]`. |
| `NOFRIES_POSTGRES_PORT`, `NOFRIES_POSTGRES_IDLE_TIMEOUT_MS` | Normally unset: defaults 5432 and 30000. Allowed integer ranges 1–65535 and 1000–60000. Dashboard fixes pool max=5, statement timeout=15000 and connection timeout=5000; corresponding general pool settings do not override these. |
| `NOFRIES_DATABASE_URL`, `DATABASE_URL` | Both **unset** for the production dashboard; password connection strings are rejected. |
| `NOFRIES_CUSTOMER_AUTHORITY_CONTAINER`, `NOFRIES_STARTER_AUTHORITY_CONTAINER` | Existing legacy customer-subject/starter stores, if used. Subject keys must belong to `NOFRIES_ENTRA_TENANT_ID`. Configured source containers must be distinct from each other and from session/proof/epoch/approval containers. At least one source is required. |
| `NOFRIES_EXTERNAL_CUSTOMER_AUTHORITY_CONTAINER`, `NOFRIES_EXTERNAL_CUSTOMER_TENANT_ID` | Existing external starter authority container and external tenant UUID, if used. Lookup scans every configured source, not just the approval's provider; grant read access to all configured sources. Do not enable a customer provider merely to enable admin. |
| `NOFRIES_ENTRA_CLIENT_SECRET`, `NOFRIES_SCOPE_SIGNING_SECRET`, `NOFRIES_PROSPECT_SIGNING_SECRET` | Preserve existing Key Vault-backed settings. Host requires a resolved Entra secret and signing secrets of at least 32 characters. Never print, copy into plans, or regenerate these during enablement. Customer client credentials, if already configured, also remain unchanged. |
| `NOFRIES_DASHBOARD_ADMIN_ACCOUNT_ACTIONS` | Keep unset/`false` for this read-only procedure (expiry and membership actions share this flag). This locator does not compose mutation executors. |

## Azure checklist (review before execution)

Fill only the non-secret identifiers below. Use the correct subscription and production App Service/slot. The example targets the production slot; add the same explicit `--slot` to **every** webapp command if reviewing a deployment slot instead. App settings changes restart the app. No step prints the app's complete settings. Do not use `--debug` or `set -x`.

```bash
set +x
umask 077
SUBSCRIPTION_ID='<subscription UUID>'
APP_RG='<App Service resource group>'
APP='<App Service name>'
DATA_RG='<application storage resource group>'
AUTH_RG='<auth storage resource group>'
APPROVAL_CONTAINER='dashboard-admin-approvals'
AUDIT_CONTAINER='<existing private admin audit container>'
JOEL_OID='<Joel user object UUID in the workforce tenant>'
PUBLISHER_OID='<approved release operator object UUID>'
PUBLISHER_TYPE='User' # Use ServicePrincipal for an approved automation identity.
az account set --subscription "$SUBSCRIPTION_ID" --output none
setting() { az webapp config appsettings list --resource-group "$APP_RG" --name "$APP" --query "[?name=='$1'].value | [0]" --output tsv; }
DATA_ACCOUNT=$(setting AZURE_STORAGE_ACCOUNT_NAME)
AUTH_ACCOUNT=$(setting NOFRIES_BROWSER_AUTH_STORAGE_ACCOUNT)
WORKFORCE_TID=$(setting NOFRIES_ENTRA_TENANT_ID)
EPOCH_CONTAINER=$(setting NOFRIES_DASHBOARD_EPOCH_CONTAINER)
PROOF_CONTAINER=$(setting NOFRIES_DASHBOARD_PROOF_CONTAINER)
SESSION_CONTAINER=$(setting NOFRIES_BROWSER_AUTH_CONTAINER)
SESSION_CONTAINER=${SESSION_CONTAINER:-nofries-browser-auth}
JOEL_SUBJECT="$WORKFORCE_TID:$JOEL_OID"
MI_PRINCIPAL_ID=$(az webapp identity show --resource-group "$APP_RG" --name "$APP" --query principalId --output tsv)
DATA_ID=$(az storage account show --resource-group "$DATA_RG" --name "$DATA_ACCOUNT" --query id --output tsv)
AUTH_ID=$(az storage account show --resource-group "$AUTH_RG" --name "$AUTH_ACCOUNT" --query id --output tsv)
```

If `NOFRIES_MANAGED_IDENTITY_CLIENT_ID` is set, replace `MI_PRINCIPAL_ID` with that identity's **principalId**, obtained using `az identity show --resource-group '<identity RG>' --name '<identity name>' --query principalId --output tsv`. Verify its `clientId` matches the setting and it is assigned to this App Service. Do not add a second identity or switch the runtime identity as part of this procedure.

1. **Inspect effective permissions first.** The approver needs permission to create role assignments (e.g. Role Based Access Control Administrator at the relevant scopes), plus management-plane container creation permission (e.g. Storage Account Contributor on the data account); the app needs neither. Container creation below uses the management plane, so it does not require giving the publisher account-wide Blob data access first. Reader assignments do not cancel inherited Contributor/Owner permissions. Remove/re-scope any existing broad app grants covering approval or epoch containers through the owner's separate RBAC review.

```bash
az role assignment list --assignee "$MI_PRINCIPAL_ID" --all --include-inherited --query '[].{role:roleDefinitionName,scope:scope}' --output table
az storage container-rm create --resource-group "$DATA_RG" --storage-account "$DATA_ACCOUNT" --name "$APPROVAL_CONTAINER" --public-access off --output none
APPROVAL_SCOPE="$DATA_ID/blobServices/default/containers/$APPROVAL_CONTAINER"
az role assignment create --assignee-object-id "$MI_PRINCIPAL_ID" --assignee-principal-type ServicePrincipal --role 'Storage Blob Data Reader' --scope "$APPROVAL_SCOPE" --output none
az role assignment create --assignee-object-id "$PUBLISHER_OID" --assignee-principal-type "$PUBLISHER_TYPE" --role 'Storage Blob Data Contributor' --scope "$APPROVAL_SCOPE" --output none
az role assignment create --assignee-object-id "$PUBLISHER_OID" --assignee-principal-type "$PUBLISHER_TYPE" --role 'Storage Blob Data Reader' --scope "$AUTH_ID/blobServices/default/containers/$EPOCH_CONTAINER" --output none
```

2. **Verify existing app prerequisites; add only missing assignments.** `Storage Blob Data Reader` on each configured customer source and epoch; `Storage Blob Data Contributor` on sessions and proofs (the BFF writes these). Existing signup workflows may already require Contributor on starter sources; do not downgrade them. Storage network/private-endpoint rules must allow the app and the operator workstation; RBAC alone does not open a firewall.

```bash
for name in NOFRIES_CUSTOMER_AUTHORITY_CONTAINER NOFRIES_STARTER_AUTHORITY_CONTAINER NOFRIES_EXTERNAL_CUSTOMER_AUTHORITY_CONTAINER; do
  SOURCE_CONTAINER=$(setting "$name")
  if [ -n "$SOURCE_CONTAINER" ]; then
    az role assignment create --assignee-object-id "$MI_PRINCIPAL_ID" --assignee-principal-type ServicePrincipal --role 'Storage Blob Data Reader' --scope "$DATA_ID/blobServices/default/containers/$SOURCE_CONTAINER" --output none
  fi
done
az role assignment create --assignee-object-id "$MI_PRINCIPAL_ID" --assignee-principal-type ServicePrincipal --role 'Storage Blob Data Reader' --scope "$AUTH_ID/blobServices/default/containers/$EPOCH_CONTAINER" --output none
for name in "$SESSION_CONTAINER" "$PROOF_CONTAINER"; do
  az role assignment create --assignee-object-id "$MI_PRINCIPAL_ID" --assignee-principal-type ServicePrincipal --role 'Storage Blob Data Contributor' --scope "$AUTH_ID/blobServices/default/containers/$name" --output none
done
```

Preserve the existing **Key Vault Secrets User** assignment for referenced secrets. Key Vault references use the App Service's system identity unless its `keyVaultReferenceIdentity` property selects a user-assigned identity; this can differ from the runtime identity above. If missing, use `az role assignment create --assignee-object-id '<Key Vault reference identity principal UUID>' --assignee-principal-type ServicePrincipal --role 'Key Vault Secrets User' --scope '<existing Key Vault resource ID>' --output none`. Azure management-plane Contributor is not Blob data access or PostgreSQL access. Do not grant the app Storage Blob Data Owner, database ownership, or maintenance authority.

3. **Verify PostgreSQL independently.** The database owner runs the existing migrations (including `0003_dashboard.sql` and `0005_dashboard_runtime.sql`, plus subsequent migrations). An Entra administrator registers the managed identity as an Entra database principal (Azure PostgreSQL `pgaadauth_create_principal_with_oid`, object type `service`, using the MI **object** ID), matching `NOFRIES_POSTGRES_USER`, and grants `nofries_runtime WITH INHERIT FALSE, SET TRUE, ADMIN FALSE`. This is SQL, not an Azure RBAC role; do not assign the app PostgreSQL server administrator. Existing migrations provide the subject/capability-reader roles and RLS. No `SUPERUSER`, `BYPASSRLS`, schema ownership or `nofries_dashboard_maintenance` membership for the app. Use the existing private database administration procedure; never print a database token or connection string.

4. **Select the read-only console after the approved release is deployed.** Preserve all other existing settings, especially secrets. Step 1's approval container and publisher assignments are not needed for the staff console; skip them. Grant the audit container role, then set the flags:

```bash
az role assignment create --assignee-object-id "$MI_PRINCIPAL_ID" --assignee-principal-type ServicePrincipal --role 'Storage Blob Data Contributor' --scope "$DATA_ID/blobServices/default/containers/$AUDIT_CONTAINER" --output none
az webapp config appsettings set --resource-group "$APP_RG" --name "$APP" --settings \
  NOFRIES_STAFF_CONSOLE=true NOFRIES_DASHBOARD_ADMIN_ACCOUNT_LOOKUP=true \
  "NOFRIES_DASHBOARD_ADMIN_AUDIT_CONTAINER=$AUDIT_CONTAINER" \
  "NOFRIES_ALLOWED_SUBJECTS=$JOEL_SUBJECT" "NOFRIES_ADMIN_SUBJECTS=$JOEL_SUBJECT" \
  --output none
```

Do not overwrite either subject list if there are separately approved staff identities beyond Joel. The remaining settings table is a prerequisite check, not permission to change the live instance, auth or database identity. In particular, enable `NOFRIES_DASHBOARD_RUNTIME_ENABLED=true` only after its existing instance/epoch foundations below have been verified. No SWA role change or new anonymous wildcard is needed: existing exact BFF edge routes remain.

## Records and their creators

| Required record | Location / creator / how |
| --- | --- |
| Current external epoch | Auth account, epoch container, `runtime-epochs/<instanceId>.json`: exactly `{"instanceId":"<UUID>","restoreEpoch":"<UUID>"}`. Existing recovery owner creates/maintains it; app and publication tool only read it. |
| Enabled native instance + history | PostgreSQL `nofries.dashboard_runtime_instance`, matching instance/epoch with `ingress_status='enabled'`, plus its `dashboard_runtime_receipts` and `dashboard_runtime_audit` history. Database/recovery owner uses `createPostgresDashboardMaintenanceRepository.initializeRuntimeInstance` (initially fenced), then `enableRuntimeIngress`, with separately approved exact operation UUID, actor subject, predecessor revision/hash, epoch and evidence reference/hash. Do not hand-insert a row or run synthetic journey tests against production. Missing/incorrect history must be repaired through that existing owner procedure before enabling admin. |
| BFF parent and original proof | Auth account, session container `browser-auth/sessions/<sha256(opaque-id)>.json` and temporary `browser-auth/transactions/<sha256(opaque-id)>.json`; proof container `dashboard-proofs/<sessionSha256>.json`. Genuine workforce login/callback creates these; they contain sensitive session material and are never operator-script inputs. Sign out/in after policy or epoch changes. |
| Native operator gate + receipts/audit | `nofries.dashboard_session_gates` (`kind='operator_dashboard'`) with linked receipts/audit. Joel opens `https://nofries.nz/dashboard-admin/entry` and explicitly chooses **Open administration**. Existing UI uses `GET/POST /api/dashboard/session`, `X-Nofries-Dashboard-Purpose: operator_dashboard`, same-origin controls and `initializeOperatorSession`. Do not manufacture SQL/proof/session rows. No customer `dashboard_identity_bindings`, membership or entitlement grant is needed to make Joel an operator. |
| Scoped approval | New data-account approval container: `dashboard-admin-approval-revisions/<targetHash>/<recordSha256>.json` and `dashboard-admin-approval-heads/<targetHash>.json`. Reviewed publication tool below creates exact canonical records; reader uses fresh head, revision/hash and epoch checks. `targetHash` hashes canonical `{recordType:'dashboard_admin_approval', operatorSubjectKey, purpose:'signup_support', instanceId}`. |
| Publication audit | Same container, `dashboard-admin-publication-intents/<recordSha256>.json`, create-only before archive/head writes. Tool prints an applied receipt only after head readback and epoch verification. Retain private command output with the decision reference; an interrupted attempt may have no success receipt. |
| Customer authority | Existing selected source containers, `customer-subjects/<sha256(subjectKey)>.json`; starter metadata at `customer-starter/starter-accounts/<email-key>.json`. Existing signup/activation services create these, not this tool. Missing authority is a lookup result, not a reason to fabricate a customer record. Lookup is bounded to 100 scanned subjects; overflow/storage errors return 503. |

The native runtime schemas and receipts are defined in [runtime repository](../api/shared/appLifecycle/postgresDashboardRuntimeRepository.js), [runtime records](../api/shared/appLifecycle/dashboardRuntimeRecords.js) and migrations; [operator session](../api/shared/dashboardOperatorSession.js) owns proof derivation. Do not copy raw operational records into this public repository.

## Publish Joel's scoped approval (superseded for lookup)

Not needed for the staff console. Kept for reference until the clean-up change removes the tool.

Use a private local request file, mode `0600`, outside the checkout. It is **not** an App Setting. Replace every placeholder with reviewed non-secret identifiers. `record.operatorSubjectKey` and `binding.operatorSubjectKey` are Joel's workforce subject; `selector.subjectKey` is the **customer's** immutable provider subject. Scope IDs come from the customer's existing authority record, not an email inference. Use the live epoch and identity policy. All timestamps below are placeholders; use current canonical UTC times, with `approvedAt = changedAt <= validFrom < validUntil` and a maximum one-hour interval. Revision 0 is only for a missing head.

```json
{
  "storageAccount": "<data-account>", "authorityContainer": "dashboard-admin-approvals",
  "epochStorageAccount": "<auth-account>", "epochContainer": "<epoch-container>",
  "expectedRevision": null, "expectedRecordSha256": null,
  "record": {
    "schemaVersion": 1, "recordType": "dashboard_admin_approval_revision",
    "operatorSubjectKey": "<workforce-tid>:<Joel-oid>", "purpose": "signup_support", "instanceId": "<instance-uuid>",
    "restoreEpoch": "<live-epoch-uuid>", "revision": 0, "status": "active",
    "changedAt": "<approved-UTC-time>", "decisionReference": "<private-decision-id>",
    "binding": {
      "schemaVersion": 1, "bindingId": "<new-uuid>", "revision": 0, "status": "active", "action": "dashboard.authority.read",
      "purpose": "signup_support", "operatorSubjectKey": "<workforce-tid>:<Joel-oid>", "instanceId": "<instance-uuid>",
      "selector": { "provider": "legacy", "subjectKey": "<customer-identity-tid>:<customer-oid>", "tenantId": "<customer-tenant-id>", "organisationId": "<customer-organisation-id>" },
      "approvedAt": "<approved-UTC-time>", "validFrom": "<start-UTC-time>", "validUntil": "<end-UTC-time>",
      "approvalReference": "<private-decision-id>", "identityPolicy": { "policyId": "<workforce-policy-id>", "policyRevision": 0 },
      "auditPolicy": { "reference": "<approved-audit-policy-id>", "revision": 0, "agreementVersion": "nf-dashboard-2026-09-r2", "retention": { "unit": "calendar_months", "count": 13 } }
    }
  }
}
```

For external customers set selector provider to `external`; Joel remains a workforce operator. Policy revisions above must be replaced with their real approved values. `auditPolicy` validates the existing thirteen-calendar-month commitment; the tool does not install retention/deletion policies or authorize a new retention arrangement.

```bash
node scripts/dashboard-admin-approve.js --request /private/admin-approval.json
# Review every destination, exact JSON body and condition in the printed plan.
# This next command WRITES: first intent, then immutable revision, then CAS head.
node scripts/dashboard-admin-approve.js --request /private/admin-approval.json --confirm '<printed-planSha256>'
```

The CLI uses the current `az login` identity via `AzureCliCredential`, no account keys/SAS/passwords. Dry run performs bounded reads but zero writes. A wrong/changed plan hash writes nothing. Exact already-applied publication is a no-op. A changed head, epoch, expired approval or audit-write failure refuses publication. On an interrupted/ambiguous upload, inspect again; do not blindly reuse confirmation. There is no transaction across Azure blobs: an epoch may change immediately after the last check, but the runtime independently refuses the old-epoch approval. A success receipt is not a continuing grant.

To renew/change scope: use the next revision in both record and binding, the current head's revision/hash as `expectedRevision`/`expectedRecordSha256`, and a fresh decision/times. To revoke: next record revision, `status:"revoked"`, `binding:null`, fresh changedAt/decisionReference, exact predecessor. The tool validates these contracts using [approvalRecords.js](../api/shared/dashboardAdmin/approvalRecords.js); it cannot mint a wildcard or a longer-lived grant.

Read the current head into a private file before preparing that next request; `HEAD_BLOB` is the final write's blob path from the retained publication plan:

```bash
HEAD_BLOB='<dashboard-admin-approval-heads/targetHash.json from the plan>'
az storage blob download --account-name "$DATA_ACCOUNT" --container-name "$APPROVAL_CONTAINER" --name "$HEAD_BLOB" --file /private/admin-head.json --auth-mode login --output none
```

## Verify and disable

Joel signs in with the workforce account and opens `/operator`. The account lookup panel opens the native operator session itself on the first lookup; email travels only in the same-origin POST JSON body. An unauthenticated request is 401; a missing native session, a non-admin subject or a disabled flag is refused; storage or audit failures return unavailable. Check RBAC, the epoch and App Service safe logs rather than weakening a gate. No user email belongs in a diagnostic URL or pasted log.

```bash
# Reversible lookup-only disable; retains all durable records and any writer locator.
az webapp config appsettings set --resource-group "$APP_RG" --name "$APP" --settings NOFRIES_STAFF_CONSOLE=false --output none
```

## Optional signup listing: separate adoption, not required above

`NOFRIES_DASHBOARD_ADMIN_BINDING` is a JSON string, at most 2048 UTF-8 bytes, with exactly `{"schemaVersion":1,"provider":"legacy","authorityContainer":"<listing-approval-container>","populationId":"<ID>","indexId":"<ID>","writerContract":"all_application_account_writes_v2"}`. Provider may instead be `external`, selecting its already-configured external starter container. Authority and source containers must differ; data/auth accounts must differ. This setting is a locator, never an operator allowlist. The admin switch controls disclosure; it does **not** stop adopted writer tracking.

Before adopting it, the release owner must quiesce old account writers, use `createBoundDashboardAdminMaintenance(..., {authoriseMaintenance, authorisePublication})` with approval of the exact rebuild/publication, inspect and rebuild the complete population, verify the checkpoint, then activate the same locator on every writer before resuming traffic. Its `inspectPopulation`/`rebuildPopulation` APIs initialize and maintain `customer-starter/dashboard-admin-signup-index/writers/head.json`, writer account tickets, index head and content-addressed revisions. Never seed these by hand or enable the locator first. The approval tool in this PR deliberately does not perform scans, rebuilds or listing adoption.

Listing additionally needs per-operator `dashboard-admin-signup-policy-heads/<targetHash>.json` and `dashboard-admin-signup-policy-revisions/<targetHash>/<recordSha256>.json`, published by `inspectApproval`/`publishApproval`; target binds instance, operator, provider, population, index and source-binding hash. Policy fixes `coverage:complete_application_signups`, fields `[email,organisation,accountType,milestones]`, page size 1–25, decision window 1000–3600000 ms, approved/valid timestamps and the same audit contract. Complete index bounds are 100 rows and 10 pages. Exact schemas and conditional publication are in [signupListingRecords.js](../api/shared/dashboardAdmin/signupListingRecords.js), [signupListingStore.js](../api/shared/dashboardAdmin/signupListingStore.js) and [signupIndexMaintenance.js](../api/shared/dashboardAdmin/signupIndexMaintenance.js). These records, native session and audit gates are independently required; the lookup approval does not grant signup listing.
