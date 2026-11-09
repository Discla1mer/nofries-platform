# Production account actions

The bound production composition uses `NOFRIES_DASHBOARD_ADMIN_ACCOUNT_ACTIONS=true` with the existing native dashboard runtime, `NOFRIES_DASHBOARD_ADMIN_ENABLED=true`, and `NOFRIES_DASHBOARD_ADMIN_BINDING`. The binding's private approval store must already contain a current scoped lookup approval for the staff operator. Environment locators never grant customer access.

On `AZURE_STORAGE_ACCOUNT_NAME`, configure all three distinct customer authority containers:

- `NOFRIES_CUSTOMER_AUTHORITY_CONTAINER` (`legacy_admin`).
- `NOFRIES_STARTER_AUTHORITY_CONTAINER` (`legacy_starter`).
- `NOFRIES_EXTERNAL_CUSTOMER_AUTHORITY_CONTAINER` (`external_starter`).

Legacy sources use `NOFRIES_ENTRA_TENANT_ID`; the external source uses `NOFRIES_EXTERNAL_CUSTOMER_TENANT_ID`. Selection uses the approved provider/subject/tenant/organisation, reads exact subject keys, and refuses ambiguous matches. It never scans email records.

Set `NOFRIES_DASHBOARD_ADMIN_AUDIT_CONTAINER` to a separate existing container on that account. Its name must differ from every authority, private approval, browser-auth, proof and epoch container. Missing or invalid optional action configuration disables actions and emits one allowlisted line without stopping startup. Existing global authentication/runtime configuration validation still applies.

SDK clients use `ManagedIdentityCredential`, selecting `NOFRIES_MANAGED_IDENTITY_CLIENT_ID` when supplied, and `retryOptions.maxTries=1`. Construction performs no storage I/O. The built-in issuers persist typed-email approvals bound to the current session and one operation for fifteen minutes. Membership approvals use the existing thirteen-calendar-month audit policy; suspend/restore uses the native PostgreSQL runtime and preserves customer data.

Joel assigns these Azure data-plane roles to the app's managed identity, scoped to each named container (no account-wide role is required):

| Storage account | Container setting | Azure role |
| --- | --- | --- |
| `AZURE_STORAGE_ACCOUNT_NAME` | `NOFRIES_CUSTOMER_AUTHORITY_CONTAINER` | Storage Blob Data Contributor |
| `AZURE_STORAGE_ACCOUNT_NAME` | `NOFRIES_STARTER_AUTHORITY_CONTAINER` | Storage Blob Data Contributor |
| `AZURE_STORAGE_ACCOUNT_NAME` | `NOFRIES_EXTERNAL_CUSTOMER_AUTHORITY_CONTAINER` | Storage Blob Data Contributor |
| `AZURE_STORAGE_ACCOUNT_NAME` | `NOFRIES_DASHBOARD_ADMIN_AUDIT_CONTAINER` | Storage Blob Data Contributor |
| `AZURE_STORAGE_ACCOUNT_NAME` | `NOFRIES_DASHBOARD_ADMIN_BINDING.authorityContainer` | Storage Blob Data Reader |
| `NOFRIES_BROWSER_AUTH_STORAGE_ACCOUNT` | `NOFRIES_BROWSER_AUTH_CONTAINER` (default `nofries-browser-auth`) | Storage Blob Data Contributor (existing session runtime) |
| `NOFRIES_BROWSER_AUTH_STORAGE_ACCOUNT` | `NOFRIES_DASHBOARD_PROOF_CONTAINER` | Storage Blob Data Contributor (existing proof runtime) |
| `NOFRIES_BROWSER_AUTH_STORAGE_ACCOUNT` | `NOFRIES_DASHBOARD_EPOCH_CONTAINER` | Storage Blob Data Reader (existing epoch runtime) |

The app does not create containers, assign roles, delete customer data, or enable the flag. No new PostgreSQL role or migration is introduced. See [the action contract](dashboard-admin-account-actions.md) for refusal and audit behavior.
