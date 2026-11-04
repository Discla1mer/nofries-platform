# Retained signup writer fence recovery eligibility

This source-only evaluator is preparation for a future recovery host. It is not mounted on an HTTP route, connected to production storage, or authority to reset, restore, complete, or release a fence. An eligibility result assesses supplied assertions for conditional planning only. It has zero authority and is not proof that assertions are authentic, complete, or current. A verifier’s boolean does not establish those facts. A qualified host must independently establish and enforce its own controls at the point of use.

The retained writer fence discussed here protects the empty-signup reset coordinator. It is distinct from the dashboard signup index's writer journal. The coordinator requires a trusted exclusive-target port that serializes participating application writers and retains an incomplete fence across process loss. Its rollback restores the exact saved account and authority bytes, rechecks the inventory and current records, and completes the fence only after final reads. An uncertain mutation or fence outcome must remain pending; elapsed time, a process restart, an absent record, or an operator assertion alone does not prove that an earlier writer cannot still act.

The evaluator binds supplied assertions to the exact operation, source revision, writer and target digests, fence identity and generation, and a digest of the full snapshot including current and original pointer versions. A trusted verifier must be injected, but no production verifier is provided, and its result is an assertion rather than proof. The assessment identifies prerequisites for any separately authorized planning; it proposes no restoration operations and performs no storage actions. Assertions cover the retained current fence, stopped admission and drained participating writers, reconciled issued calls, immutable originals and current pointers, unchanged SQL, reconciled index, and audit evidence.

## Operational qualification remains open

Before connecting any recovery host, owners must decide and document who can request and approve recovery, any separation of duties, how approvals expire or are revoked, and how immutable audit evidence is retained and reviewed. They must also specify how a host authenticates the operator, verifies current authorization at execution, binds the decision to the exact operation and target, and prevents stale or replayed decisions. The evaluator does not supply these controls.

Qualification needs evidence for the actual deployed target, including:

- Exact source revision and deployment identity, target and provider binding, operation ID, request and plan digests, and the retained fence's durable identity and generation.
- Complete writer participation and exclusion of alternate or older writers, including proof that in-flight calls cannot outlive the retained fence or bypass it.
- Durable ownership and serialization across process loss, concurrent recovery attempts and writers, with stale handles unable to complete or release a newer fence.
- Current inventory, immutable original record versions and hashes, conditional storage semantics, and reconciliation of ambiguous responses. Raw captures and customer data belong in the approved restricted evidence store, not this repository or its logs.
- An authenticated, attributable approval and an immutable audit trail covering inspection, decision, execution and outcome, including failures and uncertain effects.

Native integration tests and fault injection should exercise restart, concurrent writers and recoveries, stale handles, lost acknowledgements, and failures around retention and completion against the actual storage and fence implementation. Unit tests or a passing public CI run do not establish production qualification. Any change to the target, deployment, writer set, fence generation, evidence or approval requires re-evaluation under the eventual host's policy.

Issue #16 tracks integration and operational qualification. Existing work on writer participation, lease lifetime, reset integration and dormant recovery preparation must be reconciled without treating this document or evaluator as a composition or release authorization.
