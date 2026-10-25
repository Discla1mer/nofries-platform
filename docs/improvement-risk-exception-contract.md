# Risk and exception next-step contract

Status: **proposed next contract only; no risk/exception workflow implemented or
activated**. This records R9 groundwork alongside R5's pure list projection and
R6's explicit unverified-reference presentation. It changes no legal retention,
delete, privacy-request, incident, policy, supplier or approval rule.

## Reuse and boundary

`api/shared/improvementPlan/improvementPlanDomain.js` already owns assigned work,
status and retained completion/reopen history. PR499 supplies its service/storage
candidate; PR503 resolves exact action/evidence references into an explicitly
unpersisted candidate. None supplies a saved risk decision or a verified link.
`api/shared/securityGap/evaluateGapAssessment.js` rejects customer-supplied risk
acceptance. `docs/ncsc-gap-analysis.md` requires dedicated capabilities and
immutable approval events. Preserve those boundaries. Release-policy exceptions
and dependency audit exceptions are operational records, not customer risk models.

The next smallest useful R9 source slice should define an organisation-scoped
risk/exception proposal and immutable decision history, consuming these exact
existing action/assessment/evidence identities. Do not replace the action domain,
change its transitions, duplicate framework catalogues or reinterpret completion
as risk acceptance. Its proposed states would distinguish draft, submitted,
approved, rejected, withdrawn and expired; exact transitions remain subject to
the product/authority review before implementing approval or persistence.

## Proposed data and authority contract

| Concern | Required next contract | Observable acceptance |
| --- | --- | --- |
| Scope and provenance | Server-derived tenant/organisation; stable risk/exception ID; exact plan/action and assessment revision/digest; selected evidence artefact/version, with its verification state retained. | A foreign scope, missing source, stale proposal revision or unavailable selected version cannot produce a decision; a newer evidence version is never substituted silently. |
| Proposal | Category distinguishing risk treatment from time-limited control exception; owner; reason, affected scope and practical consequence; proposed treatment/review date. Text is inert untrusted data. | A proposal cannot set approval, approver, effective status, verified evidence or a score. Missing rationale/scope/owner is rejected before persistence. |
| Decision | Authenticated approver under an explicitly reviewed capability; retained decision ID/revision, rationale, decision time, bounded effective/expiry dates and exact proposal version. Actor IDs supplied in customer input are rejected. | Current membership/entitlement/role checked before and after the decision; revoked/expired authority denies even a replay. Roles, self-approval/separation policy and maximum duration must be selected before an executable approval slice. |
| Expiry and reopening | At the expiry instant, approval no longer applies; renewals/revocation append a new decision retaining the original. An expired exception does not complete or delete an action. | Exact-boundary tests; history and prior rationale survive renewal, rejection, withdrawal and reopening. No automatic renewal. |
| Concurrency/retry | Optimistic proposal revision and scoped idempotency intent; same intent returns the original receipt after current-access checks; changed intent conflicts. | Concurrent decisions yield one approved head; uncertain commit reconciles its exact receipt without repeating a consequential write. |
| Evidence and scoring | Retained reference, resolver candidate, persisted link and reviewed verification are distinct. Approved risk changes neither assessment attainment nor evidence confidence. | Unverified/quarantined evidence remains so after approval; no download grant or score promotion; missing evidence is visible rather than replaced by a claim. |
| Audit and disclosure | Decision audit paired with the business transaction; customer-visible allowlist; dedicated permitted approver/read capability. | Audit failure withholds/rolls back the decision; exact native transaction proof and cross-tenant/revocation tests precede activation. Do not expose internal notes or private evidence locations. |
| Exit and retention | Reuse the adopted purpose-specific retention/legal-hold and customer-handback contracts for decisions, versions, references, derivatives and restore replay. | Approved retention purpose and actual authority verified before export/deletion; withheld or held records remain explicit; access cessation, supplier copies and deletion receipts are tested for the enabled surface. No duration or deletion rule is introduced here. |

## Subsequent workflow slices

Privacy-request and incident decisions, policy/supplier reviews, scoped holds and
complete offboarding are separate consumers of the same scoped evidence and
immutable decision concepts. Each needs an exact owner, purpose, capability,
state/expiry contract, recovery and customer acceptance criteria. This document
starts their shared boundary specification; it does not claim those modules
have source implementations or select legal obligations for a jurisdiction.

## Delivery order and completion evidence

First review the roles/separation, expiry and purpose decisions, then implement
one bounded proposal/decision domain with synthetic tests; next provide reviewed
request-authorised durable storage/audit and native isolation/retry proof. Only
then integrate read/decision UI with current access checks and keyboard/mobile
acceptance. Source publication is separate from customer activation. Existing
schema, runtime, report/writer, upload and recovery holds remain unchanged.

R5 here delivers only an immutable list-data projection over the retained domain:
owner/due/status/rationale/history, filtering and explicit UTC overdue status.
It calculates neither the pilot's top three priorities nor current owner
eligibility, and supplies no completion endpoint. R6 here labels completion
references honestly; PR503 candidates remain unpersisted and are not attached
links. R9 remains this proposed contract. Durable links, evidence review,
customer exit operations and live risk/exception approval are still unmet.
