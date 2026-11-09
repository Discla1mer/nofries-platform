# Signup organisation-preparation diagnostic map

Source baseline: `cca654dc8892a980b2d21ef96f14003740297937` (9 November 2026).
The mapped signup runtime paths are unchanged since the original #53 baseline.
This is a source map and synthetic reproduction guide, not a production diagnosis.
No runtime fix follows from the generic error alone. A checkpoint identifies a
failed operation or assertion; it does not identify which underlying cause occurred.

Admin reset now means scoped suspend/restore (#125), alongside expiry extension
(#121); it does not delete signup records. These diagnostics are independent of
the delete/reset fence proposals (#20, #55–#57, #59, #61 and #76).
This guide and its tests enable no runtime feature or recovery operation.

## Read the event correctly

`customerSignupProduction.loadState` sets `organisation_preparation` immediately
before `passiveState`, then calls `organisationPrepared` only if passive state is
null. A returned `pending_preparation` or `setup_read_only` is not this exception.
Successful preparation changes the stage to `signup_state` before the handlers run.
`acceptTerms` and `resumeAcceptance` reuse these functions but do not contain that
same outer stage reporter. Inspect the request's support reference and release
identity before attributing a state-endpoint diagnostic to another request.

The safe event is `{timestamp, stage, code, supportReference, workspaceRead?,
preparation?}`. `workspaceRead` has `phase`, `checkpoint`, optional `sqlStateFamily`.
The separate writer `preparation` has `checkpoint`, `sqlStateFamily`, and
`transactionOutcome`. These are server-only, not HTTP error-body fields.

`signup_state_unavailable` is the reporter's fallback for an absent/unrecognised
own `error.code`. It includes plain `Error`, parser errors, many domain denials,
and unlisted codes. Recognised `postgres_*`, journal, registration, blob-store,
`onboarding_input_invalid` and `onboarding_record_invalid` codes remain specific.
For example a structurally invalid preparation can report `onboarding_input_invalid`,
while a structurally valid but inconsistent preparation can report the fallback.

Ordinary reads use `createPostgresDatabase`: `createTenantClient` discards driver
SQLSTATE and emits `postgres_query_failed`. Connect, BEGIN (including the role
switch), tenant-context, COMMIT and rollback have separate safe codes. Consequently
an absent read `sqlStateFamily` does **not** exclude SQL/permissions/schema failure.
The writer captures driver failures before wrapping. Its `access_or_schema` family
still cannot distinguish 42501 permissions from 42P01 table/42703 column drift.
A rollback failure can replace the top-level read code while the first captured
checkpoint is retained. No raw error text should be added to public diagnostics.

## Workspace-read paths

Locations: `lib/customerSignupProduction.js` (`passiveState`, `organisationPrepared`,
`existingOrganisationReady`, `resolveActivationBinding`) and
`lib/starterSignupProduction.js` (`readOnlyState`, `prepared`, `sqlScope`, `completed`).

Phases: **PS** = `passive_starter`; **PB** = `preparation_before`;
**PA** = `preparation_after`; **P** = `passive_state`.
`prepared` suspends the read recorder during the writer and resumes PA for readback.
Inner diagnostics already attached to an error take precedence over outer ones.
The probes below are described in the next section.

| Checkpoint | Phase / failing path | Plausible causes; read-only confirmation |
| --- | --- | --- |
| `account_match` | PS/PB `matchCurrent`; P wraps starter call if it cannot attach | Starter/legacy authority collision or changed authority; missing account; first slot differs from current tenant/org/binding. Account transport normally reports `starter_store_unavailable`. B: compare exact retained records and revisions privately; missing selected starter authority alone returns null. |
| `retained_preparation` | PS/PB context download, decode and compile | Missing context (null reaches `Object.hasOwn`), JSON/UTF-8/length corruption, provider timeout/403, wrong schema/account/slot, inconsistent plan/source/declaration/invitation. B: existence/length/ETag and codec/equality booleans; do not print source/customer fields. |
| `registration_layout` | PS/PB catalog classifier; PB also evaluates reader-only policy | Catalog query/connection failure or partial scoped layout. Normally `signup_registration_unavailable`. C: compare row_key type/nullability/PK; subject identity namespace is distinct from workspace tenant. |
| `owner_read` | PS/PB re-read session, authority and account | Expired/changed session or MFA, dual authority, changed/missing account, identity/accountType/slot/activation mismatch, provider failure. B: repeat exact owner checks with timestamps; specific auth/store codes may survive. |
| `owner_match` | PS equality check, then entry into `completed` | Owner/current/account changed since initial read; also `completed` compiles provisioning before its next mark. B: same-request revision/ETag/equality results and compiler result. |
| `scope_transaction` | PS/PB/PA transaction entry | Pool/token/network/resource failure, BEGIN/role switch failure, tenant GUC failure; invalid tenant or closed adapter can fall back. A: code plus role/connection metadata. No SQL scope SELECT necessarily ran. |
| `scope_context` | PS/PB/PA five session-local GUCs | Failure setting subject/org/binding/authority/runtime instance, connection/timeout. A: verify exact presence/equality of context in the same transaction; normal query failure has a specific code. |
| `scope_query` | PS/PB/PA starter scope SELECT | Missing relation/columns, role SELECT/USAGE denial, connection/timeout, policy drift. A/C/S: catalog and privilege booleans, same-context count. A zero-row result does not throw here. |
| `scope_cardinality` | PS/PB/PA scope result count | More than one row or invalid transport result. Duplicates require broken/missing uniqueness or result-shape drift under SQL0011; not an ordinary missing-row case. C/S: constraints and bounded count. |
| `preparation_decode` | PS/PB/PA retained SQL preparation validation | Malformed payload, unsupported plan/hash, source vs compiled state inconsistency, malformed/reused slot IDs. S/B: codec success and equality booleans against retained context; both specific codec codes and fallback are possible. |
| `preparation_match` | PS/PB/PA scope slot/subject comparison; PB/PA final preparation equality | SQL preparation belongs to another slot/subject, or retained source changed since initial read/write. S/B: compare slot/subject/compiled-preparation booleans. |
| `activation_decode` | PS/PB/PA only when activation is non-null | Invalid activation schema, consent/intent/admission compilation inconsistency. S: validate activation against the decoded preparation privately. Fresh unactivated rows skip this and all activated checks below. |
| `binding_query` | PS/PB/PA binding SELECT | Permission/schema/network issue. A/C/S: privilege and bounded exact binding count under the same role/context. |
| `binding_decode` | PS/PB/PA count + normalisation | Binding missing/hidden, duplicate result, corrupt binding/checksum. S: count and normaliser result. Missing is not proof of deletion: evaluate RLS too. |
| `binding_match` | PS/PB/PA binding assertion | Inactive binding, different ID/subject or expiry from activation. S: status/equality/expiry booleans. |
| `snapshot_read` | PS/PB/PA canonical snapshot + clock | Missing/hidden tenant/org/member/entitlement/flag/usage rows, inconsistent revision/checksum/payload, query/clock failure. S/C: bounded per-table presence then canonical snapshot codec; locks/timeouts can also fail. |
| `membership_read` | PS/PB/PA membership resolver | Missing, expired, revoked, ambiguous or wrong-subject membership. S: resolver result against the captured instant and scope. |
| `entitlement_read` | PS/PB/PA entitlement resolver and subsequent comparisons | Invalid/ineligible/expired grant, wrong grant/schedule, overview disabled (product check only when required), **or member vs binding membership/invitation/evidence/time mismatch**. S: separate eligibility and five membership-equality booleans. |
| `admission_query` | PS/PB/PA head and head-revision decision reads | Missing/hidden/multiple authority/decision rows, stale head, SQL failure. S/C: exact authority count and decision count for the head revision, privileges/RLS. |
| `admission_decode` | PS/PB/PA admission normalisation | Invalid hash/chain/record structure. S: normaliser result only. |
| `admission_match` | PS/PB/PA admission assertion | Scope mismatch, ineligible decision, not-yet-valid/expired window, effect hash or identity-policy reference differs from activation. S: individual equality/time booleans. |
| `scope_transaction_completion` | PS/PB/PA after sqlScope return; also PS completed final recheck | Usually COMMIT/cleanup failure; **also** final `again` scope absent/unactivated/unequal in `completed` after a successful second SQL read. A/S: distinguish specific commit code from semantic fallback; compare first/second snapshot. |
| `completion_receipt` | PS completed activated path | Journal read/validation/SQL failure; usually recognised journal code. S: exact tenant/org/invitation receipt and codec. Missing receipt returns false, not an exception. |
| `completion_registration` | PS completed activated path | Registration layout/header/entry failure; usually recognised registration code. C/S: identity tenant+subject context and selected entry. Missing returns false. |
| `completion_match` | PS completed activated path | Receipt differs from activation; registration not pending admission or reference fields differ; account activation subject/time/receipt differs. S/B: compare each required field privately. |
| `completion_invitation` | PS completed activated path | Invitation read/codec failure. B: bounded retained invitation validation. Missing/unaccepted/different acceptance returns false. |
| `completion_recheck` | PS completed activated path, several sites | Client slot/context read failure or invalid digest; changed final owner/account/time; final invitation/registration changed; expired session/assurance or stale client proof. B/S: ordered reread equality and expiry booleans. Second sqlScope uses its own marks, including the completion checkpoint above. |
| `scope_missing` | PA after writer and second SELECT | Writer returned but readback is empty: absent row, different scope/context/role visibility, drift or concurrent recovery. S: compare writer receipt with exact read context/count; do not rerun the writer to diagnose. |
| `preparation_recheck` | PB/PA final context reread and compile | Context disappears/changes/corrupts or provider read fails after SQL read. B: before/after ETag and codec; equality mismatch after successful compile is `preparation_match`. |
| `passive_journal` | P non-starter fallback | Journal error, generally specific code. S: exact receipt reference and read role; null continues. |
| `passive_registration` | P non-starter fallback | Catalog/registration adapter failure, generally specific code. C: layout classifier. Legacy layout returns null to allow ordinary preparation. |
| `passive_binding` | P scoped historical registration | `existingOrganisationReady` or `resolveActivationBinding` failure, including consent/reference/owner rechecks and optional starter-client availability. S/B: snapshot, reference, authority, binding checks. `DashboardPersistenceError` in readiness returns false instead of throwing. |
| `passive_binding_match` | P final binding compare | Resolved binding ID or tenant/org differs from captured authority. S/B: boolean comparison and same-request version checks. |
| `unknown` | Any enabled phase before an explicit mark | Reserved fallback; normal mapped paths mark first. Check exact deployed source/adapter and whether unexpected exceptions interrupted recorder setup. Do not infer a database cause. |

A missing scope in legacy passive inspection is allowed to reach `prepared`.
A missing scope/activation/account activation in a scoped or reader-only flow
returns `setup_read_only`; it must not be repaired by a passive read. SQL0011's
scope SELECT policy filters **subject only**; the query also filters tenant and
organisation. A missing tenant GUC alone is not that policy's explanation.

## Writer paths (separate `preparation` diagnostic)

`prepared` calls `runtime.starterProvisioning(... phase: 'prepare')` only when
its initial SQL scope is absent and the retained flow is writable. Inspect
`api/shared/appLifecycle/postgresDashboardRuntimeRepository.js` and
`api/shared/customerSignup/signupPreparationDiagnostic.js` for fixed markers.
Writer errors are often translated to unlisted `onboarding_unavailable` or
`onboarding_outcome_ambiguous`, hence the generic signup code. Read recorder
suspension is intentional; absence of `workspaceRead` is not absence of capture.

| Writer checkpoint(s) | Plausible cause and confirmation |
| --- | --- |
| `request_validation` | Invalid invocation/deadline/request ownership after diagnostic enablement. Privately validate selector and invocation invariants. Input rejection before enablement can have no detail. |
| `provider_read`, `provider_compile`, `provider_recheck` | Retained proof/provider access/compile mismatch, changed provisioning or deadline expiry. B: bounded provider/read/compile/equality results; no external write or retry. |
| `external_epoch` | External restore epoch unavailable or changed. Compare existing protected epoch with runtime instance metadata using the established reader; emit only match/status. |
| `database_connect`, `transaction_begin`, `database_context` | Connection/auth/resource, BEGIN/SET ROLE, context-setting or registration guard. A/C: role membership/privileges, deployed layout; scoped SQL0015 guard deliberately refuses fresh writes. Do not remove the guard. |
| `instance_fence`, `instance_read`, `instance_codec` | Advisory lock wait/timeout, missing/hidden runtime instance, disabled ingress, changed restore epoch, invalid instance checksum/receipt. A/S: instance/epoch equality, row presence/codec, existing lock telemetry. |
| `starter_account_insert`, `starter_account_lock` | CHECK/unique/FK/RLS/permission error; ON CONFLICT no-op then own row missing/hidden; account metadata mismatch. C/S: constraints, exact account presence and equality; do not expose email hash/subject. |
| `starter_scope_read`, `starter_scope_insert` | Missing/drifted relation, visibility, conflicting saved preparation, invalid FK/CHECK/ordinal/uniqueness, policy denial. C/S/B: scope/parent account presence, schema and retained equality. Parent client validation is under inherited markers; not all internal assertions have a unique name. |
| `bootstrap_initialisation`, `bootstrap_execute` | Invalid initial state/command or existing bootstrap state inconsistent with approved preparation. S/B: pure compiler and canonical state comparison; no reconcile write as a diagnostic probe. |
| `bootstrap_tenant_read`, `bootstrap_tenant_insert` | Tenant hidden/missing/conflicting, lock/query failure or insert constraint/policy denial. A/C/S: count, permissions, policy, existing row checksum. |
| `bootstrap_child_read`, `bootstrap_child_write` | Organisation/membership/entitlement/flags/advisor/usage row drift, missing row, FK/CHECK/RLS/permission or timeout. C/S: per-table presence/codec/constraints; family does not name the table. |
| `bootstrap_receipt_read`, `bootstrap_receipt_write` | Receipt mismatch/missing/hidden, immutable conflict, trigger/RLS/permission. C/S: operation-specific receipt existence/codec and predicates. |
| `final_instance_check` | Instance/epoch/ingress changed before sealing. S: compare captured/final instance, protected epoch and validity instant. |
| `transaction_timeout`, `transaction_commit`, `transaction_rollback` | Deadline/statement-timeout configuration, lost connection/acknowledgement, serialization/deadlock or cleanup failure. A: safe SQL family, database telemetry and retained receipt. `unknown` outcome is not rollback; `committed` is not complete end-to-end signup. |
| `unknown` | Unmapped exception or interrupted control path. Read exact source and retained safe fields before considering more instrumentation. |

## Legacy fallback without a detailed #30 checkpoint

If starter `prepared` returns null, `organisationPrepared` continues without a
read recorder. Every escaping error still has stage `organisation_preparation`:

- Journal read generally retains its own safe code; a durable receipt with any
  `customerReference` mismatch calls plain `fail()` and produces the fallback.
- Existing-member readiness reads the canonical snapshot. Persistence-domain
  failure returns false (`pending_preparation`); transport or other escaping
  errors retain their recognised code or use the fallback.
- New legacy organisation: activation approval read, activation-command compiler,
  entitlement normalisation, expected usage construction, bootstrap creation and
  `prepareInitialisation` can throw without a detailed checkpoint. Missing approval
  returns false. Confirm approval existence and pure compiler/equality outcomes.
- `reconcileInTransaction` catches `DashboardPersistenceError` and returns false;
  other failures escape. Inspect A/C/S and existing receipt instead of replaying.
- Final approval reread can throw without detail. Missing or changed approval
  returns false; it is not itself an exception.

Thus **no detail after #30** can mean this legacy path, a pre-enable writer
failure, or an error that cannot carry the WeakMap diagnostic (e.g. primitive
throw). Verify the deployed diagnostic files before treating it as a logging bug.

## Read-only confirmation probes

Only use an already authorised connection/reader. Do not grant permissions,
change policies/settings, assume a maintenance role, dump customer records, or
execute migrations. Query templates use bound parameters, never pasted identities.
A transaction-local diagnostic context is not a persistent setting change. Keep
outputs to booleans/counts and retain operational evidence in its protected store.

**A — connection/context.** Correlate the exact support reference with allowlisted
fields above in existing application traces, plus existing PostgreSQL error-class,
timeout/connection telemetry for that instant. Do not export raw messages/SQL.
Check database/role identity privately; report whether it matches expected config.
In `BEGIN READ ONLY`, use `SET LOCAL statement_timeout = '5s'`, then:

```sql
SELECT current_user = $1 AS expected_role,
       has_schema_privilege(current_user, 'nofries', 'USAGE') AS schema_usage;
SELECT rolbypassrls, rolsuper FROM pg_roles WHERE rolname = current_user;
-- Compare values in the SAME scoped transaction, not an unrelated pooled session.
SELECT current_setting('nofries.tenant_id', true) = $1 AS tenant_matches,
       current_setting('nofries.subject_key', true) = $2 AS subject_matches,
       current_setting('nofries.organisation_id', true) = $3 AS organisation_matches;
```

Connection/BEGIN failures may preclude SQL entirely. Use existing provider health
and role-membership metadata; read composition switches to `nofries_runtime` after
BEGIN, so a denied role switch appears as `postgres_begin_failed`.

**C — catalog/migrations.** `to_regclass` for each relevant table; inspect
`pg_attribute`, `pg_constraint`, `pg_class.relrowsecurity/relforcerowsecurity`,
`pg_policies` and `has_table_privilege` against source SQL0003/0005/0008/0009/0011.
Use the exact `readSignupRegistrationLayout` catalog query: no row_key = legacy;
text NOT NULL with the identity_tenant_id/subject_key/row_key PK = scoped; partial
shape is invalid. The public migration directory does not ship SQL0015; the code
recognises a separately deployed scoped shape. Do not infer deployed layout from
source alone. Compare ledger IDs/checksums **only if the existing reader already
has access**; runtime intentionally has no ledger privilege.

**S — scoped rows.** In one read-only transaction, match the actual runtime role
and transaction-local contexts from `sqlScope` (tenant, subject, organisation,
binding, authority, instance). Keep row locks out of these probes: source snapshot
reads use FOR SHARE, which cannot run in a READ ONLY transaction; these probes
therefore establish observations, not an atomic admission or writer rehearsal.

```sql
SELECT count(*) AS visible_scopes FROM (
  SELECT 1 FROM nofries.dashboard_starter_scopes
  WHERE tenant_id=$1 AND organisation_id=$2 AND subject_key=$3 LIMIT 2
) AS bounded;
SELECT has_table_privilege(current_user,
  'nofries.dashboard_starter_scopes', 'SELECT') AS can_select;
-- Finish the bounded probe without persisting anything.
ROLLBACK;
```

Repeat bounded counts for the exact binding, admission head/decision and canonical
snapshot tables. Validate preparation/activation/receipt/row codecs inside the
protected reader and emit only results. Registration reads set tenant to the
**identity tenant** (`subjectKey.slice(0,36)`) and `nofries.signup_subject_key`, not
the workspace tenant/`nofries.subject_key`. A zero count under RLS cannot distinguish
absence from hidden data. Compare with already-authorised metadata/evidence; never
bypass RLS or broaden access to settle it. Receipt and membership missing cases
have different returns described above; do not treat every zero as this incident.

**B — retained/owner records.** Through the existing bounded blob readers, compare
presence, ETag/length, schema/codec validity, account/slot/context/source equality,
authority collision, owner/session rechecks and expiry at the request instant.
Run pure compilers/validators only; do not invoke `claim`, `activate`, setup-save,
provisioning or recovery executors. Emit only fixed labels and booleans. Healthy
later reads cannot prove what a concurrently changing request saw earlier.

## Reproduction evidence and remaining uncertainty

`test/customerSignupDiagnosticsProduction.test.js` exercises the real HTTP
composition with synthetic provider/SQL responses. Added cases cover missing
account/context, context transport/JSON/account mismatch, duplicate scope result,
valid-shaped inconsistent preparation, scope binding mismatch, malformed activation,
six wrapped SQLSTATEs (permission/table/column/connection/cancel/resource), and an
empty scoped read staying passive. These establish routing, safe codes and no
customer-data disclosure, not native SQL permissions or the production cause.
The duplicate-result case intentionally violates intact SQL0011 uniqueness.

Existing `signupPreparationDiagnostics.test.js` covers writer SQL/constraint/role,
instance/provider, timeout, COMMIT/rollback/recovery faults and diagnostic parity.
Existing `signupDiagnostics.test.js` covers carrier ownership, hostile fields,
concurrency and original/public error preservation. Native SQL tests separately
exercise real policies/constraints; a transport double is not RLS evidence.
Activated workspace snapshot/admission/completion and legacy fallback rows above
remain source-mapped where this addition has no targeted fault reproduction.

Next decision: obtain one bounded live diagnostic event and confirm its released
source identity, select its phase/checkpoint and safe code, perform the corresponding
read-only checks, then reproduce that exact cause before proposing a runtime fix.
