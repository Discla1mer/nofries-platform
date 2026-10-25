# Deterministic assessment evaluator

`api/shared/assessmentEngine/assessmentEvaluator.js` is the pure numeric core
for one exact framework-profile assessment. It implements the accepted
`PROD-003-R1` score contract without a route, database, tenant admission path,
report generator, AI dependency or legacy NCSC projection.

The evaluator calculates four deliberately separate surfaces:

- attainment as an exact lower-to-upper weighted range;
- unweighted completion counts and percentage;
- evidence-state distribution and three count-based coverage levels; and
- control and domain totals rebuilt from question leaves.

Remediation priority and trend are present as reserved result lanes. They are
not calculated here because the ENG-001 framework-profile schema does not carry
the governed priority-adapter or comparability semantics needed to do so.
NCSC-003 and the later evidence/trend work may consume this result without
changing its numeric contract.

## Public interface

```js
const {
    calculateApplicabilityDecisionSha256,
    evaluateAssessment,
    serialiseAssessmentEvaluation
} = require('./api/shared/assessmentEngine/assessmentEvaluator');

const result = evaluateAssessment(input, { registry });
const canonicalJson = serialiseAssessmentEvaluation(result);
```

`registry` must be a closed ENG-001 registry exposing
`getProfile(profileId, profileVersion)`. The evaluator resolves the exact
profile itself. It does not accept a caller-supplied profile object or a
`latest` alias.

When an input contains an approved applicability decision, options must also
contain a closed server-owned `applicabilityDecisionRegistry` exposing
`getDecision(decisionSha256)`. The submitted decision must byte-match that
trusted record. A self-consistent decision and hash supplied only by the caller
cannot exclude an atom.

`evaluateAssessment` returns a deeply frozen result or throws an
`AssessmentEvaluationError` with stable `code` and `path` fields. It returns no
partial score on failure. `serialiseAssessmentEvaluation` emits the canonical
JSON used by the digest contract rather than relying on consumer object-key
order. Its bounded plain-object graph validation rejects accessors, cycles and
oversized subtrees; an own property named `length` is ordinary data unless its
container is an array. The byte ceiling counts every primitive, container and
JSON-escaped key/value contribution before canonical output is produced.

## Input schema v1

The top-level object has exactly these fields:

```json
{
  "schemaVersion": 1,
  "scoreContractVersion": "PROD-003-R1",
  "organisationId": "org-example",
  "moduleId": "module-example",
  "assessmentId": "assessment-example",
  "assessmentRevision": "rev-7",
  "profileRef": {
    "frameworkId": "framework-id",
    "frameworkVersion": "framework-version",
    "profileId": "profile-id",
    "profileVersion": "profile-version",
    "catalogueSha256": "64-lowercase-hex-characters"
  },
  "scoreAsOf": "2026-09-02T10:00:00.000Z",
  "scopePopulationSha256": "64-lowercase-hex-characters",
  "evidenceSnapshot": {
    "id": "evidence-snapshot-7",
    "sha256": "64-lowercase-hex-characters"
  },
  "riskContextSnapshot": {
    "id": "risk-snapshot-7",
    "sha256": "64-lowercase-hex-characters"
  },
  "atomInputs": []
}
```

`profileRef.sourceCatalogueSha256` is required exactly when the resolved
profile contains that field. All identity, version and digest values are exact
and case-sensitive. `scoreAsOf` is a caller-supplied canonical UTC value; the
evaluator never reads the current clock.

The evidence snapshot digest is the domain-separated canonical hash of the
complete sorted `{ itemId, evidenceState }` body supplied for this evaluation.
The risk-context snapshot digest is calculated likewise from sorted
`{ itemId, statedImpact, priorityOverlay }` entries. The module exports
`calculateEvidenceSnapshotSha256()` and
`calculateRiskContextSnapshotSha256()` for producing those bindings. Evaluation
fails if either submitted body differs from its pinned digest.

There must be one `atomInputs` entry for every `profile.questions[].id`. Caller
order is ignored and duplicates are rejected before scoring.

```json
{
  "itemId": "question-id",
  "response": { "optionId": "partial" },
  "evidenceState": "documented_current",
  "statedImpact": "high",
  "priorityOverlay": "none"
}
```

Omitting the `response` property means missing. A literal `null` is invalid.
Evidence states are `not_provided`, `attested`, `documented_current`,
`tested_or_observed_current`, `independently_reviewed_current`, `stale`,
`inaccessible`, `disputed` and `unavailable`. Impact and overlay values are
validated and retained for their separate governed lanes; they cannot change
attainment or completion.

## Scoring compatibility gate

ENG-001 profiles describe versioned catalogue vocabulary. PROD-003-R1 adds a
stricter scoring contract. Before it evaluates any atom, this module requires:

- each scored question weight to be a positive safe integer;
- exactly one allowed applicable option for each factor `1`, `0.5`, `0` and
  `null`, mapped by the frozen PROD-003-R1 contract to yes, partial, no and
  explicit unknown; and
- every non-applicable option to have `applicable: false` and a null factor.

The ENG-001 synthetic fixture intentionally contains fractional weights. It is
a valid catalogue fixture but is not PROD-003-R1-scoreable. The evaluator
rejects it with `invalid_atom_weight`; it never scales or rounds the catalogue.

Questions are the only scored leaves. A question's `controlId` identifies its
single parent and the control identifies its single domain. Source references
and crosswalks are provenance, not additional scoreable atoms.

## Exact arithmetic

Weights are positive integers and implementation credit uses integer half-units:

| Response | Lower units | Upper units | Completion earned |
| --- | ---: | ---: | --- |
| Yes | `2 × weight` | `2 × weight` | Yes |
| Partial | `1 × weight` | `1 × weight` | Yes |
| No | `0` | `0` | Yes |
| Explicit unknown | `0` | `2 × weight` | No |
| Missing | `0` | `2 × weight` | No |
| Unapproved N/A claim | `0` | `2 × weight` | No |
| Approved N/A | excluded | excluded | excluded |

The attainment ratio is `credit units / (2 × applicable weight)`. Completion
is deliberately unweighted: known applicable response count divided by
applicable atom count. Parent totals sum leaf raw values; displayed parent
percentages are never averaged.

Completion is labelled `complete` when every applicable atom has a known
yes/partial/no response, `provisional` when any applicable atom remains
unresolved, and `not_scored` when there is no applicable population. This label
does not collapse or replace the attainment range.

All percentage calculations use `BigInt` division and exact decimal half-up at
one place. There is no per-question rounding. The output retains raw units,
weight/count denominators, integer percentage tenths and fixed one-decimal
display strings. A zero denominator returns `not_scored` and null percentages,
never a fabricated zero or hundred per cent.

## Not-applicable authority

A selected non-applicable option requires:

1. permission in that exact question's response-option set;
2. an `applicabilityClaim.rationaleSha256`; and
3. for exclusion, a complete approved decision tied to the same organisation,
   module, assessment and revision, framework/profile versions, catalogue,
   scope population, question and rationale.

A reasoned claim without an approved decision stays applicable and is
normalised to unresolved unknown. Its atom retains
`responseOrigin: "claimed_not_applicable"`, and the result increments
`claimedNotApplicableAtoms`. Only an exact decision whose content digest is
valid and whose approval time is no later than `scoreAsOf` excludes the atom.

Call `calculateApplicabilityDecisionSha256(decisionCore)` to calculate the
domain-separated content digest before adding it as `decisionSha256`. The
digest proves content integrity, not approver authority. Authorisation and
immutable storage remain responsibilities of the upstream authenticated
service, and the evaluator enforces that boundary by resolving the same record
from its separately supplied trusted registry.

Changing the approved decision set changes `applicabilityBasisSha256`; a future
trend adapter must treat that as a rebaseline boundary.

## Evidence lane

Evidence counts only applicable atoms and never changes attainment:

- provided coverage counts attested or current stronger evidence;
- substantiated coverage counts documented-current, tested/observed-current or
  independently-reviewed-current evidence; and
- tested coverage counts tested/observed-current or independently-reviewed
  evidence.

Stale, inaccessible, disputed and unavailable evidence remain distinct and do
not count as current coverage. Each coverage result retains its numerator,
denominator, percentage tenths and one-decimal display.

## Provenance and digests

The result pins the evaluator ID/version/source hash, score contract and
rounding rule; organisation/module and assessment revision; framework/profile
versions and catalogue digests; score time; scope, evidence and risk snapshot
digests; and domain-separated hashes of the canonical mapping, weight set,
scored atom set, applicability basis and resolved input.

`outputSha256` is SHA-256 over canonical validated output excluding only the
`outputSha256` field itself. The hash is integrity evidence, not a signature,
approval or issued-report envelope.

Canonical ordering is domain order/ID, control order/ID, then question
order/ID. Object keys use stable ASCII order. Evaluation does not use locale,
time zone, environment, randomness, network calls or AI/model output.

If resolved profile metadata declares `effectiveFrom`, the date portion of
`scoreAsOf` must be on or after that date. A pre-effective tuple fails closed
with `profile_not_yet_effective`. If a resolved framework source declares
`reviewDueAt`, `scoreAsOf` must not be later than that date. A stale source
fails closed with `framework_snapshot_stale`. Both bounds use only the explicit
scoring time.

## Boundaries and recovery

This additive module has no runtime caller yet. It does not change
`api/shared/securityGap/evaluateGapAssessment.js`; the protected legacy digest
and behaviour remain unchanged until NCSC-003 supplies an explicit adapter.

It also does not persist inputs, authenticate snapshot authority, issue a
customer report, calculate remediation sequencing, compare historical results
or produce narrative. Those are separate governed work items. Before merge,
recovery is to close the source-only pull request. After merge, recovery is a
revert of the additive evaluator, version, test, fixture, documentation and
ExecPlan files.
