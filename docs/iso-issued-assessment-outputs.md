# ISO assessment outputs in the issued-report flow

Held design for #500. The ISO board summary and Statement of Applicability can be viewed on screen. The protected results host has no export callback until an issued artifact can be verified for the selected assessment.

## What the current issuer can prove

The [lifecycle issuer](../api/shared/appLifecycle/lifecycleService.js) takes an organisation, reporting month, expected revision and explicit confirmation. Its checker freezes the monthly service measures. Its independent issuer binds the approved snapshot digest to the organisation, customer, month and issue time. [Monthly Proof](../api/shared/appLifecycle/monthlyProof.js) and the [portal reader](../api/shared/customerPortalService.js) verify those retained records. The [snapshot and envelope normalisers](../api/shared/appLifecycle/customerOperations.js) accept exactly the monthly statement shape. Neither stores an assessment revision, output kind, or digest of either ISO document. A monthly Proof for the same organisation and period cannot establish what was approved for an ISO assessment.

The dashboard [reservation policy](../api/shared/appLifecycle/postgresDashboardBootstrap.js) maps `report_exports` to `board_reports` and `report.read_issued`, with a null framework on the reservation. Its receipt records quota consumption. The resource service must independently establish immutable issued status. The assessment source and the report grant therefore need separate checks.

## Server binding and hand-off for review

1. The maker selects one of two outputs, `iso_board_summary` or `iso_statement_of_applicability`. Resolve the selected tenant and organisation and exact paid entitlement on the server. Load and verify the sealed 0030 revision and the exact ISO publication. ISO-5 supplies one deterministic projection per output, shared with the server, including the approved wording and ordering. Freeze its customer-safe contents and format version. Derive the output digest from those contents.
2. Bind a durable report ID to the tenant, organisation, complete source profile reference, assessment ID, submission revision and response-set digest, output kind, format version and output digest. The checker reviews that exact projection. The independent issuer issues the same approved digest using the existing maker/checker/issuer separation and immutable subject checks. A changed projection or source requires a new approval. Keep the two outputs independently identifiable.
3. On an explicit Copy or Print action, ISO-5 supplies the intended output, action, issued report ID, selected assessment ID, expected revision and response-set digest, plus an idempotency key. The server derives the actor and scope from the current selected session. Verify the retained issuance, exact source and requested output, paid entitlement, applicable sharing/representative-details gate, and existing issued-report read permission. Reserve through the existing quota policy and return only the verified issued projection after the final disclosure check. A duplicate intent must retain its original reservation and still pass current authority. Passive display makes no reservation. A server receipt cannot establish whether a clipboard write or physical print succeeded.

## Persistence boundary (0031)

Migration 0031 (applied) provides the dashboard-owned artifact record `dashboard_iso_report_artifacts`, with a source foreign key to the full 0030 revision key, and the append-only `dashboard_iso_report_decisions` (approved, issued), each decision by a different subject. It grants no issuer, customer reader or export privilege.

Resolve the operator's lifecycle organisation to the dashboard scope through an authoritative server mapping. A matching display name, caller-supplied ID or matching month is insufficient. Reuse the current approval/issuance authority for the mapped organisation; a paid member cannot issue a report by submitting an assessment. Specify and review issuer and reader roles before proposing any privileges on the 0031 tables. The staff wipe already deletes 0031 decisions and artifacts before their paid source; keep that coverage.

## Dependency and acceptance

ISO-1 owns the server binding. Before enabling it, add authoritative linkage between the issuer's organisation and the selected dashboard tenant/organisation, and separately approved issuer/reader grants on the 0031 store. The monthly Proof schema, paid assessment revisions, operational events and usage receipts each have distinct retention and authority rules. Any new schema or grant needs its own held proposal, with reset/delete and rollback coverage. This proposal contains no migration or grants.

Review against main (0030 storage, runtime, results, ISO publication, protected host and #512's issued ISO projection are merged). Test both independently issued output kinds, pre-issue and unissued output rejection, cross-tenant and switched-generation denial, revoked entitlement, stale revision, changed projection bytes, exhausted quota, duplicate/concurrent intent, sharing-gate failure and zero reservations on passive or denied requests. Confirm the existing reservation point and replay behavior for both actions before wiring controls. Continue treating paid improvement-plan writes separately under #500.
