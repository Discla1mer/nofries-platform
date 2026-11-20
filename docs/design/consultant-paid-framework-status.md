# Consultant view of client assessment status

**Held for an owner decision.** A consultant can select a client, open Cyber Security and read that client’s entitled assessment list on the paid stack. A page showing several clients’ NIST CSF or ISO 27001 readiness self-assessment statuses needs an additional cross-client read. Until that decision, use the organisation chooser and open each client deliberately. [Current 375px chooser (fictional accounts)](../../.github/pr-evidence/n4/consultant-chooser-375.png)

## Where the current reads stop

| Existing read | What it proves |
| --- | --- |
| Organisation directory and managed-client setup | The directory returns binding IDs and labels for this subject. The owner’s setup list shows a request ID, organisation name and setup state. The own workspace can appear alongside clients. Neither response carries assessment authority or status. Matching display names, request IDs or bare organisation IDs across these lists is unsafe. [Portfolio directory](https://github.com/Discla1mer/nofries-platform/blob/a29ef1faec046cdca65ad99bf80dfeb217257e43/api/shared/database/dashboardRequestDatabase.js#L1286) · [Setup list contract](https://github.com/Discla1mer/nofries-platform/blob/a29ef1faec046cdca65ad99bf80dfeb217257e43/js/dashboard-loader.js#L900) |
| Consultant work queue | The server checks the consultant account, session generation and each enumerated target. The target binder admits only `improvement.list`. Before releasing the page, it rechecks every contributing target under that same operation. A plan, including one with a source assessment, gives no evidence of current paid access or assessment status. [Account gate](https://github.com/Discla1mer/nofries-platform/blob/a29ef1faec046cdca65ad99bf80dfeb217257e43/api/shared/dashboardRuntimeHandlers.js#L782) · [Operation gate](https://github.com/Discla1mer/nofries-platform/blob/53a413f3c6a3129757dc1e02f1f5ea1e6aa16ce9/api/shared/database/dashboardRequestDatabase.js#L622) · [Final recheck](https://github.com/Discla1mer/nofries-platform/blob/53a413f3c6a3129757dc1e02f1f5ea1e6aa16ce9/api/shared/database/dashboardRequestDatabase.js#L1385) |
| Paid collection in #507 | For the **selected** tenant and organisation, this read checks session generation, assessment permission and the exact entitled module, profile and version. It returns a publication and paginated assessment heads. Its keys include both tenant and organisation. Background client switching would change the session generation and could leave a previously read client’s status visible after revocation. [Scoped read](https://github.com/Discla1mer/nofries-platform/blob/53a413f3c6a3129757dc1e02f1f5ea1e6aa16ce9/api/shared/assessmentLifecycle/paidAssessments.js#L156) |

The existing client-status helper can classify supplied records. Its assessment port is unwired and may be absent. Issue #22 asks about NCSC summaries. A decision for NCSC alone would leave paid profiles outside that authority. [Existing helper](https://github.com/Discla1mer/nofries-platform/blob/a29ef1faec046cdca65ad99bf80dfeb217257e43/api/shared/improvementPlan/consultantClientStatusService.js#L125) · [Client workspace #21](https://github.com/Discla1mer/nofries-platform/issues/21) · [Open decision #22](https://github.com/Discla1mer/nofries-platform/issues/22)

## Decision and acceptance criteria

**May a consultant receive one coarse status per entitled framework across their currently authorised clients?** If Joel approves this read, the next design must specify how the server identifies a client binding, excludes the consultant’s own workspace and proves the exact paid read for every target again immediately before disclosure. No need for new stored status has been demonstrated. The existing assessment revisions contain the source data.

For a separately approved implementation, put the view in consultant **Organisations**. Require `NOFRIES_PAID_FRAMEWORKS_ENABLED` exactly `true`. In module `cyber_security`, the current pins are `nf-nist-csf-2-0-core/2026-09-08.1` and `nf-iso-27001-2022-readiness/2026-11-19.1`. Return only the authorised binding ID, display label, exact framework tuple and status. Use the existing deliberate selection and recheck when opening a client. Keep publications, answers, assessment IDs and scores out of the portfolio response.

| Proposed status | Evidence after confirming this client’s active product grants the pinned framework |
| --- | --- |
| Not started | A complete, authorised read finds no assessment. |
| In progress | A current assessment head is `created` or `in-progress`. We propose showing an open attempt ahead of an earlier submission. |
| Submitted | At least one current head is `submitted` and no open attempt exists. |

Omit paid information for a free client, an unentitled tuple or an unproven client relationship. A truncated or failed read cannot establish an empty list. If authority changes during assembly, discard the page. With the flag off, or for a company, staff or unclassified account, expose no paid portfolio controls, assets, counts or statuses.

Before release, exercise mixed paid/free clients with identical organisation IDs in different tenants, both profiles, empty/open/submitted and mixed histories, a second page of records, client revocation during assembly and stale generations. Verify no selection writes or retained cross-client data, and keyboard navigation at 375px. This design can be reviewed independently on main. Any implementation follows explicit paid-summary approval, the paid runtime and its held storage dependency, and requires independent access review.
