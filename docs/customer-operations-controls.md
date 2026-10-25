# Customer operations controls

Last updated: 31 August 2026.

This document is the operating standard for converting an approved No Fries proposal into a managed customer, completing technical onboarding and admitting the customer to service operations. It describes controls implemented in the shared runtimes. It does not by itself authorise a live supplier write: the Datto bridge remains disabled by default, and its narrow controlled-write path requires approved authority, least-privilege runtime configuration and an explicit operator action.

## Non-negotiable rules

- The lifecycle customer master is the operational control record. A CRM or supplier identifier is a typed cross-reference, not permission to activate service.
- Customer acceptance, onboarding and service status are separate decisions. An `accepted` customer is not an `active` customer.
- Different customers may be in technical `onboarding` at the same time. Every mutation remains revision-checked and every Datto create-capable action uses a customer/plan-specific durable provisioning claim; the same customer cannot hold two active provisioning claims or start a second onboarding plan.
- G0 through G4 must be complete before activation can be requested. G5 requires three different human identities: maker, checker and executor.
- A device name is not an identity. Every planned device must map one-to-one to an observed Datto RMM UID.
- Simulated, disabled, missing, stale, future-dated or truncated evidence never satisfies a production control.
- A tenant crossover, duplicate external mapping or ambiguous customer match is a stop condition. Do not work around it.
- Never enter credentials, access tokens, recovery codes or raw security configuration as evidence or in an outbox payload.
- Datto authentication uses a dedicated API identity and server-side API-key/secret exchange. Never automate a human's Datto browser password or MFA challenge, and never return a key, secret or token to the browser.
- A generated installer handoff is not permission to install. Endpoint administrator/UAC, macOS TCC, device approval, policy/Autotask mapping and remote sessions retain their separate human controls.

## Authority and system boundaries

| System | Intended authority | Current implementation boundary |
|---|---|---|
| No Fries sales workspace | Discovery, assessment, reviewed service plan and proposal | Creates or links a sales customer and assessment. Approved proposal versions are immutable and carry a server-generated SHA-256 seal over the exact customer-facing snapshot. Its scoping lifecycle handoff uses a durable operation and target inbox receipt; the proposal-ready handoff independently verifies and binds the exact sealed proposal. |
| Lifecycle customer master | Customer identity, accepted authority, service schedule, contacts, entitlements, billing profile, external crosswalk, onboarding, service status and Proof controls | Operational control record. State transitions and eligibility are enforced here. |
| HubSpot | Commercial company, deal and contact identifiers | Typed, manually verified reference only. No live HubSpot read/write connector is implemented. |
| Apollo | Prospecting/enrichment identifier | Typed reference only. It cannot establish customer authority or overwrite verified customer facts. No live connector is implemented. |
| Autotask | Production account, agreement and service-ticket source of truth | A verified account crosswalk and exact tenant/workspace/provider-scope/company binding are required. A portal writer additionally needs one current contact crosswalk, and a fresh bounded Autotask contact read must verify that exact contact still belongs to that exact company before a write. The production adapter implements bounded ticket reads, create and customer-visible replies with a durable operation fence. Customer portal reads additionally require the exact reviewed portal-visibility UDF; company membership alone is not visibility. Status writes remain disabled. Source implementation is not evidence that provider entitlement, credentials or production cutover have passed. |
| Datto RMM | Managed site plus observed device and alert evidence | The separate bridge is bounded. `readonly` discovers and reconciles. `controlled_write` may exchange a dedicated API key/secret server-side, create or reuse only the exact authorised managed site and generate site/platform-scoped installer handoffs. Linking stores a snapshot in the lifecycle record. Device moves/approval, policy changes, Autotask mapping, jobs, alert resolution, remote sessions and remediation are not supplier writes exposed by this adapter. |
| Kaseya MDR | Security monitoring evidence | The customer master and Proof schema can carry a typed MDR reference/evidence item. No live MDR connector is implemented. |
| Backup platform | Backup/recovery evidence | Proof source only. No live connector is implemented. |

The supported external systems are `sales_workspace`, `hubspot`, `apollo`, `autotask`, `datto_rmm`, `kaseya_mdr` and `backup`. A verified external reference records its system, record type, external ID, verification mode, evidence reference, verifier and time. Manual verification requires an explicit confirmation and an evidence reference. Provider verification is reserved for dedicated server-side integrations and cannot be asserted through the manual route. External IDs must not be shared across customers. Singleton company/account/site mappings cannot be silently replaced: retire the exact manual mapping with reason, evidence and confirmation, then verify the replacement. Provider-managed mappings can be changed only by their dedicated integration.

## Role separation

| Action | Required capability | Roles normally holding it |
|---|---|---|
| Record acceptance | `customer:accept` | Admin, service owner |
| Start/update onboarding | `onboarding:write` | Admin, service owner, consultant |
| Replace mutable customer-master profile | `onboarding:write` | Admin, service owner, consultant |
| Replace SLA, channels or authorised requesters | `service-status:write` | Admin, service owner |
| Discover or map supplier records | `integration:discover`, `integration:map` | Admin, service owner |
| Start controlled Datto site preparation | `integration:provision`, `lifecycle:write`, `lifecycle:transition` | Admin, service owner |
| Approve activation | `onboarding:approve` | Admin, service owner |
| Execute activation | `onboarding:execute` | Admin, service owner |
| Change service status | `service-status:write` | Admin, service owner |
| Record Proof evidence | `proof:write` | Admin, service owner, consultant |
| Approve Proof | `proof:approve` | Admin, service owner |
| Run internal customer controls | `customer-controls:run` and `tenant:admin` | Admin |

Role capability is necessary but not sufficient. Activation compares stored principal/email identities and rejects a maker-checker, maker-executor or checker-executor match. The service-desk approval flow also stores maker, checker and executor identities and fails closed when an independent identity is missing.

## Controlled customer workflow

All mutations require the current `expectedRevision`; a stale revision returns `409` and must be reloaded rather than overwritten.

1. Prepare discovery and proposal in `/scoping`. Use `GET /api/sales/lifecycle-handoffs/{organisationId}` to review the handoff and duplicate candidates, then `POST` the same route with exact organisation and lifecycle revision confirmation.
2. Approve the proposal in Sales. Approval assigns a version and seals the exact customer-facing snapshot with a server-generated SHA-256; an approved version cannot be edited. From the lifecycle scoping record, use **Bind approved proposal**. Lifecycle independently verifies the exact tenant, Sales customer, assessment, lifecycle organisation, proposal ID, version and hash before moving to `proposal`. Generic lifecycle patches cannot set these identifiers.
3. At proposal state, record the customer's signatory, accepted/effective time and authority evidence. Acceptance must match the proposal binding already recorded in step 2. Before onboarding, save and manually verify the HubSpot company and Autotask account through the dedicated crosswalk route. Start onboarding with the complete customer master, signed support profile and one or more planned devices with unique stable IDs and an explicit customer/device owner or authorised installer email. The onboarding request reuses only server-stored, governed crosswalks and rejects caller-supplied or unverified identifiers. Different customers may onboard independently; customer/plan claims and a tenant-wide canonical Datto-site-name fence prevent duplicate preparation.
4. With the bridge still `disabled` or `readonly`, confirm the customer authority, exact site name, planned device platforms and rollback owner. During an approved `controlled_write` window, run the idempotent Datto preparation action to create or reuse that exact managed site and obtain Windows/macOS installer handoffs plus any site-provided Linux installer tasks. An authorised person completes endpoint administrator/UAC, terminal/sudo and macOS TCC prompts as applicable. Link the site, human-confirm every physical device to one Datto UID, review device approval plus policy/Autotask mappings and resolve the expected-versus-observed estate.
5. Record G4 customer monitoring acceptance. Request G5 activation, have an independent checker approve it, then have a third independent person execute it.
6. Activation moves the lifecycle record and service status to `active`, completes onboarding, creates a day-30 review and installs internal control schedules.
7. Use the evidence-bound service-status route to suspend, resume, begin offboarding or complete offboarding. Never emulate these actions with a generic lifecycle patch.
8. Use the evidence-bound customer-master and support-profile change routes for contact, entitlement, billing, schedule, SLA, channel and authorised-requester changes. Each replacement retains the prior version, records the reason/evidence and revokes any pending activation approval.

## G0-G5 evidence standard

| Gate | Required result | Evidence/control detail |
|---|---|---|
| G0 — authority | Verified commercial acceptance | Acceptance is bound to the immutable approved Sales proposal already linked to the lifecycle record. Lifecycle recomputes and verifies its seal, version, SHA-256 and customer/assessment/organisation links. Store signatory, acceptance time and authority basis/reference. The acceptance idempotency key cannot be reused with different evidence. Legacy unsealed approvals fail closed and must be replaced by a newly approved version. |
| G1 — access readiness | Complete operational master and platform crosswalk | Legal/trading identity; sponsor, security, billing and after-hours contacts; signed service schedule/version/hash/start/SLA/support hours; entitlements; billing profile; signed support profile and authorised requesters. External customers also need verified HubSpot company, Autotask account and Datto site mappings. Controlled site preparation must reuse the exact authorised site or fail closed; it cannot resolve an ambiguous mapping. |
| G2 — planned devices | Every planned device verified and identity-matched | Each planned device has a unique stable No Fries ID, a recorded supported platform and explicit owner/authorised-installer email, status `verified`, match status `confirmed` and exactly one Datto RMM device UID observed in the linked snapshot. A UID cannot be assigned to two planned devices. Windows/macOS installer handoffs and the manual site-provided Linux installer task do not replace local administrator/UAC or macOS TCC approval, physical-device confirmation, Datto device approval, or the reviewed policy/Autotask mapping. |
| G3 — estate reconciliation | Exact, fresh, complete device reconciliation | Linked Datto site; non-truncated snapshot no older than 24 hours; expected count equals observed count; every planned UID appears once in the current snapshot. |
| G4 — monitoring acceptance | Current customer acceptance of the service/monitoring baseline | G0-G3 complete first. Evidence must be live or manual, not simulated; must not be expired; must include `customerAcceptedAt` and customer authority reference; open high-risk exceptions block the gate. |
| G5 — governed activation | Approved request consumed without evidence drift | Maker records an idempotent request and confirms no unresolved high-risk exceptions. Request expires after 48 hours. Checker and executor are different from the maker and each other. Execution recomputes the evidence fingerprint; any plan, customer-master, Datto snapshot or authority change revokes the request. |

Directly marking G5 complete is blocked. If G0-G4 evidence changes after approval, create and review a new activation request.

## Operational API routes

| Method and route | Purpose |
|---|---|
| `GET /api/sales/proposals/{proposalId}` | Read the server-generated approval seal used by the operator acceptance flow. |
| `POST /api/lifecycle/organisations/{id}/proposal-ready` | Verify and bind the exact sealed proposal/customer/assessment relationship, then move scoping to proposal. |
| `POST /api/lifecycle/organisations/{id}/commercial-acceptance` | Record acceptance only after server-side verification of the exact sealed proposal binding. |
| `POST /api/lifecycle/organisations/{id}/onboarding/start` | Create the versioned external onboarding plan. |
| `POST /api/lifecycle/organisations/{id}/external-reference` | Add or update a typed, verified system crosswalk. |
| `POST /api/lifecycle/organisations/{id}/customer-master/change` | Replace mutable customer-master fields with evidence, revision control and prior-version retention. |
| `POST /api/lifecycle/organisations/{id}/support-profile/change` | Replace SLA/channels/authorised requesters with evidence, revision control and prior-version retention. |
| `POST /api/datto-rmm/onboarding/prepare` | After explicit customer-authority, authorised-device, no-conflicting-management, supported-OS and New-Device-Approval confirmations, create/reuse that customer's governed Datto site, sync the first snapshot, move planned devices to `installer_ready` and return platform-correct handoffs/manual gates. |
| `POST /api/datto-rmm/sites/{siteUid}/link` | Read a bounded site snapshot and link it to the confirmed lifecycle organisation. |
| `GET /api/datto-rmm/sites/{siteUid}/snapshot?organisationId={id}` | Read a snapshot only after the site-to-organisation mapping is verified. |
| `POST /api/lifecycle/organisations/{id}/onboarding-device` | Progress a planned device; verification requires a linked Datto site and confirmed match. |
| `POST /api/lifecycle/organisations/{id}/device-match` | Confirm a planned device to an observed Datto UID. |
| `POST /api/lifecycle/organisations/{id}/onboarding/evidence` | Record controlled G1 or G4 evidence. |
| `POST /api/lifecycle/organisations/{id}/activation-requests` | Maker requests G5 activation. |
| `POST /api/lifecycle/organisations/{id}/activation-requests/{requestId}/review` | Independent checker approves or rejects. |
| `POST /api/lifecycle/organisations/{id}/activation-requests/{requestId}/execute` | Third identity executes and consumes the approved request. |
| `POST /api/lifecycle/organisations/{id}/service-status` | `suspend`, `resume`, `start_offboarding` or `complete_offboarding`, with reason and authority reference. |
| `GET/POST /api/lifecycle/organisations/{id}/proof` | Read a period; an omitted GET selects the last completed customer-local month. Evidence writes require an explicit `YYYY-MM` period and lifecycle revision. |
| `POST /api/lifecycle/organisations/{id}/proof/approve` | Approve only an explicit, complete and fresh period using the current lifecycle revision. |
| `POST /api/lifecycle/controls/run` | Generate due internal-only control tasks after explicit confirmation. |
| `GET /api/customer-portal/tickets/operations/{operationId}` | Poll the signed customer's own durable create/reply operation without resending ticket text. |
| `GET /api/service-desk/operations/{operationId}` | Let governed staff inspect one durable provider operation and its unresolved step metadata. |
| `POST /api/service-desk/operations/{operationId}/resolve-absent` | `service_owner`-only resolution after the exact two-read Autotask settlement quarantine; unsupported for `status_patch`. |
| `GET /api/sales/operations` | Inspect non-completed durable handoffs. |
| `GET /api/sales/operations/{operationId}` | Inspect one durable handoff. |
| `DELETE /api/sales/customers/{customerId}` | Admin-only, exact-name-confirmed deletion of unaccepted Sales evidence, coordinated with the Lifecycle scoping link by source and target fencing plus a durable completion receipt. |

The `/operator` UI supplies these controlled workflows. API examples are intentionally omitted because evidence identifiers and hashes must come from approved records, not copied sample values.

## Datto RMM controlled onboarding

Keep `NOFRIES_DATTO_RMM_MODE=disabled` until the API and installer origins, dedicated API identity, least-privilege security levels, allowed hosts, exact customer/site identity and rollback owner are approved.

The modes are deliberately asymmetric:

- `disabled` makes no Datto calls and is the default and rollback state;
- `readonly` uses server-side API-key/secret exchange, or the legacy access-token setting, for health, discovery and bounded snapshot reconciliation only;
- `controlled_write` requires the dedicated API key/secret and adds only idempotent create/reuse of the exact managed site plus platform/site-scoped installer handoff generation.

In every enabled mode:

- `NOFRIES_DATTO_RMM_TENANT_ID` binds the whole provider account to one exact No Fries/Entra tenant; requests from any other lifecycle tenant fail before Datto is called;
- only admins and service owners can enumerate partner sites or map a site;
- a site snapshot request requires `organisationId` and the stored site UID must match before any provider call;
- the adapter bounds the snapshot and refuses to link truncated data;
- the lifecycle record stores captured time, snapshot hash, device UIDs/count and alert count for reconciliation;
- the API key, API secret and OAuth token remain server-side and are omitted from errors, audit, logs and browser responses;
- an interactive Datto login, browser password or MFA response is never stored or automated.

The dedicated Datto API identity, provider-account tenant binding and protected runtime settings are shared platform controls. The customer workflow is repeatable: every accepted customer keeps a separate lifecycle organisation, exact customer/site identity, contracted endpoint baseline, agreed representative device plan, provisioning claim, marked Datto site, installer handoffs, reconciliation evidence and G0-G5 approvals. A credential or Datto site is never shared as the customer boundary.

In `controlled_write`, each customer site request requires the current lifecycle revision, explicit customer-authority, authorised-device, no-conflicting-management, supported-operating-system and New-Device-Approval confirmations, an approved customer in governed onboarding and the exact normalised lifecycle display name. The existing `No Fries HQ` and `No Fries Headquarters` lifecycle labels are one reserved HQ identity; the supplier site is canonicalised to `No Fries Headquarters` and either alias is considered during duplicate discovery. Before any create-capable call, a durable lifecycle/ETag provisioning claim binds the tenant, organisation, canonical site, plan version, exact devices and confirmations. A concurrent claim fails before Datto is called. An existing site is reused only when it carries the ownership marker for that same tenant/organisation; no match creates one site. An unmarked same-name/alias site, multiple or ambiguous matches, a cross-tenant mapping, blocked device, stale revision or mismatched claim fail closed. The write allowlist does not include site deletion, device moves, device approval, policy change, Autotask mapping, jobs, alert resolution, remediation or remote control.

The returned Windows/macOS installer handoff only identifies the authorised site and planned platform. The endpoint owner or authorised technician must open it on the matching device, approve local administrator/UAC or macOS privacy/system-extension/TCC prompts and separately confirm the physical-device-to-Datto-UID match. A human reviews device approval, assigned policy, Autotask mapping and any later remote session before G2/G4 acceptance.

Follow [the Datto RMM customer-onboarding runbook](datto-rmm-trial-runbook.md) for the reusable customer sequence, shared credential handling, the No Fries HQ seven-day acceptance exercise and rollback.

## Service-desk admission

A ticket is admitted only when all of the following are true:

- the record is a customer, lifecycle and service status are both `active`, and onboarding is complete;
- every planned device is verified and identity-matched;
- the signed support contract is current and has an SLA schedule reference;
- the requester list is non-empty;
- the Datto site is linked and reconciled with a complete snapshot no older than 24 hours;
- the selected device belongs to the customer and is verified.

The same current-customer admission is rechecked before investigation, approval and execution. If service, SLA, requester, device or RMM readiness changes after approval, execution is blocked and the outstanding remediation approval is revoked. Suspending a customer therefore stops both new and already-open work from crossing the action boundary.

For every ticket, record requester email, intake channel (`email`, `phone` or `portal`), verification method and a non-secret verification evidence reference. The channel must be allowed by the signed support profile. The requester must be effective at the ticket time. A missing, expired or unauthorised requester fails closed.

Production selects `NOFRIES_SERVICE_DESK_PROVIDER=autotask`; the legacy deterministic desk remains available only when that provider is not selected. Autotask admission requires controlled-write mode, the independent write-enable switch, exact mapping configuration, a stable provider-account identifier, Azure-backed operation storage, an allowed write scope and a current lifecycle/provider binding. Secrets stay server-side in version-pinned Key Vault references. A username, secret or integration code is not the provider identity and credential rotation must not change replay scope.

The staff `/support` workspace and customer `/portal` use the same Autotask ticket source. Staff may see all tickets admitted by their governed customer directory. Customer administrators see only their one lifecycle-bound company and only tickets carrying the exact portal-visibility UDF value. Portal note projection accepts only positively customer-published note types and masks internal notes. The portal supports list, detail, create and reply; it does not expose status changes or remediation. Every mutation uses a stable operation ID and a durable provider fence so an ambiguous response is reconciled rather than repeated. The portal and staff desk can poll that exact durable operation without resending the ticket body; customer status reads are bound to the original signed subject and verified requester email.

Manual absence resolution is an exceptional `service_owner` action, not a retry shortcut. It is allowed only for the exact unresolved ticket-create or note step and attempt after two fresh, exact Autotask negative reads against the same provider target, separated by a six-minute quarantine beyond Autotask's documented five-minute execution window. A provider-present result, read failure, wrong target or stale attempt blocks resolution. `status_patch` is unsupported by the resolver, and Autotask status writes remain disabled for this release.

Datto RMM does not become a second ticket database. Configure Datto RMM's native Autotask PSA integration so device-originated tickets enter the same Autotask company/source-of-truth boundary. The No Fries Datto onboarding adapter remains separately bounded and does not expose ticket, policy, remote-session or remediation writes.

## Durable sales-to-lifecycle handoff

The scoping handoff writes the sales customer, assessment and durable operation in one sales-workspace mutation. The operation has a stable idempotency key, immutable semantic payload hash, correlation metadata, attempt/lease state and bounded secret-safe payload. The request then tries immediate delivery. The lifecycle target records an inbox receipt keyed by operation ID and payload hash, preventing the target effect from being repeated.

A completed-operation replay also checks that the exact Sales customer and assessment links are still materialised in Lifecycle. If an otherwise valid receipt exists but a failed cross-store deletion attempt removed the links, Lifecycle restores only the IDs bound to that receipt and audits the rematerialisation. Customer deletion first persists a leased source-side claim before Lifecycle is touched, so a second delete or completed-handoff replay cannot enter the unlink window. Lifecycle records the same claim with a monotonically increasing generation; a superseded worker cannot restore an older link or regress a compensated/completed fence. A source conflict compensates by restoring only the exact receipt-bound link and then releases the claim. A Lifecycle organisation cannot be deleted while its fence is unlinked or compensated.

The Sales delete and its minimal deletion-completion receipt are one atomic mutation. If Sales is removed but the Lifecycle completion response fails, the receipt remains `source_deleted` with the exact customer, organisation, assessment, claim and fence generation. Lifecycle retains completed target receipts by claim so a replacement handoff cannot erase proof or replay a deleted customer/assessment. Repeating the admin delete with the exact customer-name confirmation resumes only that fence, completes Lifecycle idempotently and marks the receipt `target_completed`. If that exact Lifecycle organisation is authoritatively absent, the absence proves it cannot retain or rematerialise the old link and the source receipt closes as `not_found`. This recovery does not rely on the now-absent customer record or its stale workspace revision. Ambiguous storage responses are reconciled against the claim and durable receipts before a result is returned.

- `200/201` with `convergence: completed` means both stores acknowledged the link.
- `202` with `convergence: pending` means the sales records and operation are durable but convergence is not acknowledged. Do not create a replacement customer. Inspect the operation and retry the same confirmed handoff after the error is resolved.
- A reused idempotency key with different content is a conflict and must be investigated.
- `pending`, `claimed`, `retry` and `dead_letter` operations require operator attention. Preserve correlation IDs and errors when escalating.

Immediate in-request delivery is implemented. A continuously running lease recovery/retry dispatcher and production dead-letter alert are not yet provisioned.

## Monthly Proof and recurring controls

Activation installs internal schedules for daily connector freshness, daily SLA exception review, monthly Proof, monthly managed-count/billing reconciliation and quarterly service review. Suspension, offboarding and former status disable those schedules; an explicit resume re-enables them. The hosted scheduler wakes daily and `POST /api/lifecycle/controls/run` creates deterministic internal operator tasks for due controls only. Neither path performs a supplier write or automatically collects evidence, generates a monthly statement, approves it or issues it.

Each Proof period uses `YYYY-MM` in the customer's configured reporting timezone, with `Pacific/Auckland` as the fallback. A read may omit the period and will select the last completed customer-local month. Evidence recording requires an explicit period and an expected lifecycle revision; an identical retry may converge read-only even when that revision is stale. Approval requires an explicit period and the current lifecycle revision. These mutation inputs prevent a retry from moving to another month at a timezone boundary. Approval also requires fresh evidence for every entitlement-derived required source. The governed source set is `service_desk`, `datto_rmm`, `mdr`, `backup`, `change`, `risk`, `billing` and `roadmap`; `mdr` and `backup` are added only when active entitlements map to them. Each accepted item needs a source, checksum, evidence reference and captured time; readiness also requires a future `freshUntil`. `simulated` and `disabled` sources remain incomplete. Future-dated evidence is rejected. Approval requires a separate explicit completeness confirmation.

An issued customer report is labelled a **No Fries-attested monthly statement**. Its approved snapshot and later publication envelope have independently recomputable SHA-256 content hashes, privacy-safe evidence receipts and immutable internal maker/checker/issuer audit identities. The customer portal publishes only an explicitly issued statement whose complete evidence was frozen by the maker/checker approval and whose publication envelope passes integrity checks; a due scheduler task alone is never customer-visible Proof. These hashes detect content changes; they are not an independent audit, digital signature or non-repudiable external timestamp. Post-live hardening should add a versioned Key Vault signing key and an immutable external transparency anchor without changing or backdating the original approved snapshot hash.

## Fail-closed rollout settings

Before the protected service-desk cutover, production keeps the new surfaces disabled:

```text
NOFRIES_SERVICE_DESK_PROVIDER=mock
NOFRIES_AGENT_RUNTIME=mock
NOFRIES_AUTOTASK_MODE=disabled
NOFRIES_AUTOTASK_WRITE_ENABLED=false
NOFRIES_CUSTOMER_PORTAL_ENABLED=false
NOFRIES_CUSTOMER_PORTAL_WRITES_ENABLED=false
NOFRIES_CUSTOMER_PORTAL_WRITE_SCOPE=disabled
NOFRIES_SERVICE_DESK_WRITE_SCOPE=disabled
NOFRIES_MONTHLY_PROOF_SCHEDULER_ENABLED=false
NOFRIES_DATTO_RMM_MODE=disabled
NOFRIES_HANDOFF_OUTBOX_ENABLED=false
NOFRIES_INTERNAL_DISPATCH_ENABLED=false
NOFRIES_SCHEDULER_ENABLED=false
NOFRIES_CUSTOMER_MASTER_SHADOW_ENABLED=false
NOFRIES_ENTITY_STORE_MODE=blob
NOFRIES_ENTITY_STORE_WRITE_ENABLED=false
```

The protected cutover derives a canary settings map from one reviewed complete target map. Phase one requires four distinct signed identities: the primary customer admin, a valid second-customer admin, a separate invalid/unmapped identity and a separate staff `service_owner`. The primary needs a portal-visible Datto-originated ticket, a same-company unmarked/internal ticket, and current plus archived issued Proof. The second customer needs its own portal-visible ticket and issued Proof. Each valid customer must positively read its own ticket and Proof and receive the masked/not-found result for the other customer's exact ticket and Proof; the invalid identity must be rejected separately. The cutover then proves one new ticket, replay and durable status polling of that exact operation, one staff reply, restart durability and healthy runtime controls. Only then may phase two set both write scopes to `governed`. Boolean settings alone do not create provider entitlement, UDFs, API users, contact/company crosswalks, customer memberships or issued Proof reports.

App Service application settings are written as a complete map. The cutover therefore requires a fresh exclusive-writer/change-freeze attestation, exact before/after map digests and no out-of-band setting changes for the duration. This is an explicit single-writer operational assumption, not a compare-and-swap guarantee. If a foreign concurrent settings write is observed or suspected, stop; do not overwrite it with the saved snapshot until an owner has reconciled the authoritative map.

## Operator checks and rollback

Before starting onboarding:

1. Confirm the linked proposal and acceptance evidence, duplicate review and exact customer identity.
2. Confirm no other customer is in technical onboarding.
3. Validate signed schedule, contacts, authorised requesters, entitlements, billing and verified external mappings.
4. Confirm a rollback owner and customer communication path.

Before activation:

1. Reload the record and confirm G0-G4 are complete with no high-risk exception.
2. Confirm the Datto snapshot is complete and less than 24 hours old.
3. Confirm maker, checker and executor are three separate approved identities.
4. Confirm the request payload hash still represents the intended customer master, plan, devices, snapshot and authority.

If a control fails:

1. Stop the workflow; do not bypass a gate or rewrite evidence.
2. For operational risk after activation, use the evidence-bound `suspend` service-status action. Do not delete the customer or audit history.
3. Use the protected emergency-disable operation to set `NOFRIES_AUTOTASK_MODE=readonly`, `NOFRIES_AUTOTASK_WRITE_ENABLED=false`, `NOFRIES_AUTOTASK_STATUS_WRITES_ENABLED=false`, `NOFRIES_CUSTOMER_PORTAL_WRITES_ENABLED=false`, both write scopes to `disabled`, and `NOFRIES_MONTHLY_PROOF_SCHEDULER_ENABLED=false`. This preserves bounded ticket reads and integrity-checked already-issued Proof reads while stopping every portal/provider mutation and scheduled task creation. Reconcile any in-flight operation from its durable receipt before retrying. For a separate Datto concern, set `NOFRIES_DATTO_RMM_MODE=disabled`, reload the runtime to discard cached tokens, and rotate or revoke credentials only with explicit authority.
4. Preserve lifecycle audit, outbox operation, inbox receipt and correlation IDs. Treat any tenant crossover as a security incident.
5. Correct the source evidence or mapping, take a fresh snapshot and create a new activation request if the prior fingerprint was revoked.
6. Resume service only with a recorded reason and customer authority reference.

Approved/sealed Sales proposals and accepted lifecycle evidence are retention records. Customer deletion is blocked when that evidence exists. A draft Sales customer linked only to lifecycle scoping is unlinked before Sales deletion; failure to unlink leaves the Sales source untouched for a safe retry.

## Not yet production-complete

The following dependencies remain explicitly unimplemented or unprovisioned:

- live HubSpot and Apollo connectors and approved field/deduplication mappings;
- verified active Autotask PSA entitlement, a least-privilege production API identity/integration code, exact queue/source/issue/status/priority/note/UDF mappings, and successful signed live canaries;
- confirmed Datto RMM native integration to that Autotask PSA tenant for device-originated tickets;
- live Kaseya MDR and backup evidence collectors;
- background outbox lease recovery, retries, dead-letter alerting and scheduled customer-control execution;
- per-entity/Cosmos persistence, customer-master shadow/cutover and a tested point-in-time recovery drill;
- an externally immutable audit store; current application audit is retained and hash-chained but remains in the application workspace;
- trusted automatic service-desk/Datto/MDR/backup Proof collectors; the first portal release can publish governed manually attested evidence but must label it accurately;
- live-provider credentials, least-privilege roles, the four distinct signed cutover identities and reciprocal positive/masked ticket and Proof fixtures, field mapping approval, UAT evidence and rollback rehearsal.

Until the external prerequisites and cutover canaries pass, keep Autotask and customer-portal writes disabled and report the source as implemented awaiting verification, not live. Do not buy an entitlement, accept vendor terms, create provider users or rotate credentials without the separately required authority.
