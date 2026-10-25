# NCSC-aligned security gap analysis

## Status and boundary

This add-on is a foundational cyber-security gap screen for New Zealand SMEs.
It uses the NCSC Cyber Security Framework for report navigation, the ten Minimum
Cyber Security Standards 2025 v3 domains for high-level screening, and a
separately dated snapshot of the NCSC Critical Controls for cross-reference.

The first implementation slice is deliberately a pure domain module. It has no
route, database, customer evidence, external integration or production UI. It
can validate an already-authorised assessment value and produce a deterministic,
serialisable report for later operator and customer experiences.

Use this wording in customer-facing reports:

> NCSC-aligned foundational cyber-security gap screen. High-level No Fries
> domain screening informed by the NCSC Minimum Cyber Security Standards 2025
> v3, adapted for SME use.

This screen does not assess every Minimum Standard requirement or establish
CS-CMM conformance. It is not an NCSC certification, endorsement, official NCSC
score, compliance determination or prediction of breach likelihood.

## Source model

| Layer | Use in No Fries | Version handling |
| --- | --- | --- |
| NCSC Cyber Security Framework | Five report sections: Guide and Govern; Identify and Understand; Prevent and Protect; Detect and Contain; Respond and Recover | Framework status and source URL are pinned in the profile |
| Minimum Cyber Security Standards | Ten foundational domains for a high-level screen; direct domain guidance remains the source of requirement-level detail | Profile pins 2025 v3, published 30 October 2025 |
| NCSC Critical Controls | Date-stamped cross-references plus four explicit checks not represented as separate Minimum Standard domains | Snapshot was verified 31 August 2026 and is due for review by 31 August 2027 |

The four explicit Critical Control checks are organisation-provided password
management, sensitive-request verification, application control, and network
separation or segmentation. They are labelled as Critical Control extensions;
CS-CMM maturity labels are not applied to them. Cross-references between the
Standards, Critical Controls and extension functions are No Fries
interpretations, not an NCSC-issued mapping.

NCSC scopes the Minimum Standards to business-critical and externally facing
systems where applicable. Every assessment must list its systems and record a
`minimumStandardsScopeRationale` explaining how the No Fries scope applies or
adapts that source boundary.

The source catalogue is exposed by
`api/shared/securityGap/ncscProfile.js`. Every assessment pins `profileId` and
`profileVersion`; every generated report also records a canonical SHA-256 digest
of the complete catalogue. The expected digest is pinned as a literal invariant.
Before a second version is added, the module must introduce a registry that
retains every historical profile needed to regenerate issued assessments.

All `NF-NCSC-*` identifiers are issued by No Fries for stable traceability.
They are not official NCSC control identifiers.

## Assessment and evidence semantics

An assessment records scope, systems in scope, exclusions, sampled systems and
one bounded response per catalogue item. Supported implementation responses are:

| Response | Meaning |
| --- | --- |
| `yes` | The No Fries domain-screening prompt is met |
| `partial` | The No Fries domain-screening prompt is partly met |
| `no` | The No Fries domain-screening prompt is not met |
| `unknown` | The implementation state has not been established |
| `not_applicable` | The item is excluded for a recorded reason |

Evidence state is reported separately as `customer_asserted` or
`not_provided`. References must be bounded opaque identifiers rather than URLs,
paths or evidence content. Narrative fields reject common secret patterns, but
this is only a guardrail and not a substitute for a future evidence-ingestion
and scanning service.

The evaluator deliberately rejects customer-supplied `verified` states, risk
acceptance and maturity levels. Those outcomes need tenant-authorised reviewer
or approver records, dates, provenance and audit history that do not exist in
this pure slice. N/A responses require a rationale, remain visibly subject to
review, and cannot exclude every Minimum Standard domain.

The NCSC CS-CMM levels remain source metadata only. This screen does not assess
their cumulative requirement-level criteria and therefore does not calculate,
accept or average a maturity level.

## Transparent progress range

The report leads with counts and completeness. It then calculates a No Fries
implementation-progress range, not an NCSC score:

```text
lower = (yes + 0.5 × partial) / applicable items
upper = (yes + 0.5 × partial + unknown) / applicable items
```

Missing responses are treated as unknown. A justified not-applicable response
is removed from the denominator. The lower bound shows self-reported weighted progress if
all unknowns prove absent; the upper bound shows the best case if all unknowns
prove implemented. Reporting both bounds prevents missing discovery work from
being silently treated as either success or failure.

## Findings and roadmap

Every applicable item becomes either an implementation gap, an assurance gap,
or an assessment gap. A self-assessed `yes` remains an assurance gap until a
later authorised review workflow exists. Ordering is a deterministic No Fries
sequencing aid based on the response, stated business impact, date-stamped
Critical Control cross-reference and self-assessment evidence state. It is not
NCSC prioritisation or risk scoring. The numeric sequencing value remains
internal; the report exposes its method, band and reasons.

Open findings are grouped into 0–30, 31–60 and 61–90 day windows anchored to the
report generation date. A supplied due date remains a separate customer
commitment and is labelled when it falls outside the recommended window. The
evaluator uses a supplied action when present and otherwise provides one bounded
starting action from the catalogue. It never invents an owner, accepts risk or
marks work as complete.

## Domain interface

```js
const { getNcscGapProfile } = require('./api/shared/securityGap/ncscProfile');
const {
  evaluateGapAssessment,
  projectCustomerGapReport
} = require('./api/shared/securityGap/evaluateGapAssessment');

const profile = getNcscGapProfile();
const internalReport = evaluateGapAssessment(assessment, {
  generatedAt: trustedServerClock.toISOString()
});
const customerReport = projectCustomerGapReport(internalReport);
```

`getNcscGapProfile()` returns a defensive clone. `evaluateGapAssessment()` is
pure, does no I/O, does not mutate its input and throws a typed
`GapAssessmentValidationError` for invalid values. The explicit customer
projector removes organisation identity, sampled systems, internal notes,
evidence references and narrative evidence detail through an allowlist. All
remaining text is still untrusted and must be output-encoded at each HTML, PDF
or CSV sink. The synthetic fixture at
`examples/ncsc-sme-gap-assessment.json` demonstrates the complete input shape.
`generatedAt` is mandatory and must come from a trusted server clock; it anchors
the roadmap and the Critical Controls snapshot-age warning.

The internal report SHA-256 is a deterministic change detector for projection
and later snapshot work. It is not a signature, proof of authenticity or
authorisation token; issued reports still require tenant-authorised immutable
storage and approval audit events.

## Later integration requirements

Persistence and APIs must be tenant-bound from server-derived identity and must
retain optimistic revisions, append-oriented audit history and immutable issued
report snapshots. A customer route should derive its organisation rather than
accepting an organisation identifier. Evidence references need separate access
control, retention, scanning, provenance, age and redaction rules. Staff-only
evidence review and risk acceptance need dedicated capabilities and immutable
approval events. Accepted and completed roadmap actions can later feed No Fries
monthly Proof without making this add-on the platform's primary commercial
product.

No route, persistence or UI should be added until the current customer portal
and Service Desk contracts have landed and the integration receives a fresh
tenant-isolation, privacy and security review.

## Authoritative sources

- [NCSC Cyber Security Framework](https://www.ncsc.govt.nz/protect-your-organisation/ncsc-cyber-security-framework/)
- [Minimum Cyber Security Standards](https://www.ncsc.govt.nz/protect-your-organisation/minimum-standards/)
- [NCSC Cyber Security Capability Maturity Model](https://www.ncsc.govt.nz/protect-your-organisation/capability-maturity-model/)
- [NCSC Critical Controls](https://www.ncsc.govt.nz/protect-your-organisation/summary/)

The NCSC material is attributed with its published reuse terms. Minimum Standard
guidance is represented by source metadata, official domain titles, direct
source links and concise No Fries paraphrases.
