# PostgreSQL persistence foundation

## Status and boundary

This foundation is implemented for the Service Desk and Lifecycle modules as separate persistence vertical slices. It is not a production cutover and it does not provision Azure resources.

| Area | Current position |
| --- | --- |
| Service Desk | `postgres` provider available by explicit configuration |
| Lifecycle | `postgres` provider available by separate explicit configuration |
| Sales | Existing local/Azure Blob providers unchanged |
| Browser sessions | Dedicated auth-only memory/Blob store unchanged |
| Files and evidence | Blob Storage remains the intended store |
| App Service | Direct host and non-production declaration implemented; not provisioned, deployed, configured, cut over or live |
| Service Bus and workers | Later, separately reviewed milestone; absent from the milestone-3 declaration |

There is no Blob/PostgreSQL dual write. Do not switch a module with authoritative data until a separately reviewed import and cutover procedure exists. The pre-customer verification path uses empty databases and synthetic tenants.

## Configuration

Select PostgreSQL independently for either implemented module only after all numbered migrations have been applied:

```text
NOFRIES_SERVICE_DESK_STORAGE_PROVIDER=postgres
NOFRIES_LIFECYCLE_STORAGE_PROVIDER=postgres
```

Local development and CI use one connection URL:

```text
NOFRIES_DATABASE_URL=postgresql://<test-user>:<test-password>@127.0.0.1:5432/<test-database>
```

`DATABASE_URL` is accepted as a local/CI compatibility alias. Both URL settings fail closed when `NODE_ENV=production`; do not place a database password in App Service settings.

Hosted Azure execution uses Microsoft Entra managed identity:

```text
NOFRIES_POSTGRES_HOST=<server>.postgres.database.azure.com
NOFRIES_POSTGRES_PORT=5432
NOFRIES_POSTGRES_DATABASE=<database>
NOFRIES_POSTGRES_USER=<database principal mapped to the app managed identity>
```

The runtime requests the fixed Azure Database for PostgreSQL token scope and enforces certificate-verified TLS. The optional bounds are:

```text
NOFRIES_POSTGRES_POOL_MAX=10
NOFRIES_POSTGRES_STATEMENT_TIMEOUT_MS=15000
NOFRIES_POSTGRES_CONNECTION_TIMEOUT_MS=5000
NOFRIES_POSTGRES_IDLE_TIMEOUT_MS=30000
```

Values outside the supported ranges fail during configuration rather than silently expanding resource use.

## Apply migrations

Run migrations with a database deployment identity, not the application runtime identity:

```bash
NOFRIES_DATABASE_URL=postgresql://<migration-user>:<password>@127.0.0.1:5432/<database> npm run db:migrate
```

The runner discovers numbered SQL files under `database/migrations`, obtains a transaction-scoped advisory lock and records the SHA-256 checksum of each applied file. Reapplying the exact set is safe; editing an already-applied migration is rejected as checksum drift. Correct a released schema through a new numbered migration.

The numbered migrations create:

- the `nofries` schema and checksum ledger;
- a tenant registry and module revision rows;
- tenant-scoped Service Desk users and tickets;
- append-oriented Service Desk audit events with deterministic insertion order;
- tenant-scoped Lifecycle organisations and their ordered onboarding/device, activation and provider-reference records;
- ordered Lifecycle conversations, admissions, security events, approvals, operator tasks, schedules, control runs, dead letters, observability and corrections;
- durable Lifecycle inbox receipts with tightly bounded rematerialisation updates;
- append-only, uncapped Lifecycle audit records, with only the latest 1,000 records materialised into an operational repository state;
- composite tenant keys and references;
- forced row-level security policies; and
- the non-login `nofries_runtime` group with bounded data privileges and no DDL or bypass authority.

The migration/deployment identity owns schema changes. The hosted application database principal must be a separate login/Entra principal granted membership in `nofries_runtime`; it must not own the schema or tables and must not have `SUPERUSER`, `BYPASSRLS`, `CREATEDB` or `CREATEROLE`.

## Tenant enforcement

The browser never supplies a trusted tenant identifier. Existing authentication and tenant access code resolves the tenant on the server before the repository is called.

Each repository operation then:

1. checks that a server-derived tenant key is present;
2. opens a database transaction;
3. sets `nofries.tenant_id` with transaction-local scope;
4. reads or mutates rows whose primary and foreign keys begin with the server-derived tenant column (`tenant_id` or `tenant_key`); and
5. commits or rolls back the complete revision, entity and audit change.

Forced row-level security independently compares each row with the transaction-local setting. A restricted connection with no tenant setting sees no tenant rows. Transaction-local scope prevents a pooled connection used for tenant A from retaining that context when it is later reused for tenant B or for a no-context query.

This RLS boundary isolates No Fries workspaces. A workspace can still contain several customer organisations, so RLS alone is not customer-portal membership enforcement. Every organisation-scoped route must continue applying server-side capability and customer-membership checks before repository access.

Service Desk and Lifecycle keep their existing `read(access)` and `mutate(access, { expectedRevision, ... }, mutator)` contracts. A Lifecycle read takes a shared lock on the module revision so it cannot combine an old revision with newly committed entity rows; a mutation takes the conflicting update lock, rejects stale revisions, executes the deterministic mutator and writes the module's normalized records, durable receipts, revision and new audit events atomically. A virgin `readAudit` that observes no revision row returns that fixed revision-0 empty page immediately because PostgreSQL cannot lock an absent row. Audit identifiers are immutable within a tenant, including after an event falls outside the 1,000-row operational window; a conflicting replay fails atomically with an immutable-audit conflict. Lifecycle preserves collection order explicitly and stores the immutable Entra `tid:oid` actor identifier alongside display email metadata when it is available. Consequential maker/checker/executor records use that canonical subject for separation-of-duties checks; legacy records fall back conservatively until explicitly migrated.

The Lifecycle audit table remains complete and append-only. Normal reads and mutations fetch the newest 1,000 audit rows in SQL, return them in chronological order and chain new events from the true latest row. Sequence allocation uses the database maximum while the module revision is locked, so the operational window does not reset or collide after the table exceeds 1,000 rows. The explicit `readAudit` repository API pages against a fixed sequence boundary, and organisation export uses it rather than silently treating the operational window as the full archive. Synchronous export requires `lifecycle:audit:read` and is limited to 5,000 events, 4 MiB of serialized audit data, ten pages and ten seconds; larger archives fail explicitly with HTTP 413 pending a separately reviewed streaming or asynchronous export.

Public prompt-injection telemetry is accepted only for an already-persisted prospect conversation and is rechecked inside the locked mutation. Durable rolling-day limits allow at most two records for either a signed session or protected client identifier and at most 100 records for the tenant. A quota rejection occurs before security evidence or audit is appended and rolls back without changing the module revision. The normal 30-day policy therefore bounds public-mutable security state to about 3,000 rows; the audit record remains free of raw prompts and network addresses.

The first Lifecycle adapter intentionally retains whole-state rehydration and replacement for compatibility with proven domain mutators. Moving high-volume operations to narrow per-entity commands and paged read models is the next persistence optimisation; no live external provider should be enabled while its call would hold this transaction open.

## Verification

The pull-request workflow starts an ephemeral PostgreSQL 17 service and runs:

```bash
npm run db:migrate
npm run db:migrate
npm run test:postgres
```

The second migration run proves replay. The database tests use a restricted login that is a member of `nofries_runtime`, not the migration owner, and cover:

- two tenants using the same logical ticket/request identifiers;
- direct and repository-level cross-tenant isolation;
- pooled tenant A → tenant B → no-context reuse;
- stale and concurrent revision conflicts;
- failed-mutator rollback;
- restart/readback persistence;
- deterministic audit ordering and immutable audit conflicts; and
- Lifecycle receipt/deletion-fence persistence, provider-reference uniqueness and ordered aggregate restart readback;
- shared-read/write locking, fixed virgin audit snapshots and audit continuation/duplicate-ID rejection beyond 1,000 stored events;
- durable prospect-security session/client/tenant quotas across service restarts with no-write rejection;
- immutable Entra-subject actor separation and bounded application-error mapping;
- governed customer offboarding/deletion with schedule cleanup and retained historical control evidence; and
- schema and database error sanitisation.

Local runs skip the database integration suite when no explicit test database URL is configured. A passing mock-only run is not evidence that PostgreSQL RLS works; the CI database job is required before merge.

## Rollback and cutover rule

Before PostgreSQL receives an authoritative module write, rollback is simply leaving the existing provider selected. After an authoritative write, never direct traffic to a stale Blob copy. Use forward recovery or a separately verified data rollback/import procedure.

Production enablement additionally requires a non-production Azure deployment, managed-identity login and role readback, two synthetic tenants, backup/restore rehearsal, observability, exact-SHA verification and explicit approval. This foundation does not satisfy those live acceptance gates by itself.

The compile-tested non-production platform declaration and direct-host contract are documented in `docs/dynamic-platform-nonproduction.md`. They do not apply migrations, create the runtime database principal, provision Azure or change any provider in a live environment.
