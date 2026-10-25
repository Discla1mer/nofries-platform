# Accepted NCSC evaluator adapter

NCSC-003 makes the accepted NCSC-002 profile explicitly evaluable through
ENG-003. `api/shared/assessmentEngine/ncscAssessmentEvaluator.js` is an additive,
pure source adapter. It does not change runtime evaluator selection, the
historical NCSC evaluator, accepted catalogue content, scoring semantics or
tenant/provider admission.

## Interface and exact compatibility

```js
const {
    ACCEPTED_PROFILE_REF,
    evaluateAcceptedNcscAssessment
} = require('./api/shared/assessmentEngine/ncscAssessmentEvaluator');

// fullInput is already authorised and follows the complete ENG-003 schema.
const result = evaluateAcceptedNcscAssessment(fullInput);

// Only for exclusions backed by separately trusted current approval records:
const approvedResult = evaluateAcceptedNcscAssessment(fullInput, {
    applicabilityDecisionRegistry: trustedDecisionRegistry
});
```

The adapter closes its registry over the single accepted publication. Input must
contain the entire exact profile tuple; missing values are never filled in and
historical versions are never silently upgraded:

| Field | Required value |
| --- | --- |
| `moduleId` | `cyber_security` |
| `frameworkId` | `nz-ncsc-cyber-security-framework` |
| `frameworkVersion` | `beta-verified-2026-09-02` |
| `profileId` | `nz-ncsc-mcss-2025-v3-sme` |
| `profileVersion` | `2026-09-02.1` |
| `catalogueSha256` | `32c3f8d154ffe2be9b1270f8fa1234427a05cdea96b231588cce0b147e7d5375` |
| `sourceCatalogueSha256` | `26ccecee78ade16607e5e8c194d585dc47c7921f2eea54b2c76776e0d961b6ee` |

`ACCEPTED_PROFILE_REF` is frozen catalogue metadata for a trusted caller to
inspect; it is not membership, entitlement, assessment or approval authority.
The only optional dependency is the same trusted applicability-decision registry
used by ENG-003. A caller cannot replace the framework registry, select `latest`,
supply an alternate profile object or use an options getter to change authority.

The full input schema, canonical explicit `scoreAsOf`, exact organisation and
assessment/revision identifiers, scope/evidence/risk snapshot bindings, one atom
envelope per question, evidence semantics, integer arithmetic and N/A decision
requirements are documented in [deterministic-evaluator.md](deterministic-evaluator.md).
Omitting a response means missing; omitting the entire question envelope is an
error. All fourteen accepted questions have weight 1. Cross-references are not
additional scoreable atoms.

The adapter first delegates full input validation and evaluation to ENG-003,
then rejects any module other than `cyber_security` before returning a result.
It never reads unchecked input accessors or returns partial results. Failures
remain `AssessmentEvaluationError`; adapter-specific codes are
`ncsc_options_invalid` and `ncsc_module_unsupported`.

## Results and historical compatibility

Successful output is the exact unchanged, deeply frozen ENG-003 result. The
adapter does not relabel its evaluator, add fields inside the digest envelope,
round again or introduce a second arithmetic implementation. Provenance remains
bound to evaluator `no-fries-deterministic-assessment-evaluator`, version
`2026-09-02.1`, source digest
`d27f39d71d191fc8ca63eb1c4f4df7ab2368a72732894f120ab5bc8500eddb9e`,
the exact accepted profile/source tuple, assessment revision and snapshot hashes.
The digest remains integrity evidence, not a signature, approval or access token.

The historical profile `2026-08-31.1`, its registry default, legacy
`evaluateGapAssessment`, existing synthetic example and legacy tests remain
unchanged. The new adapter rejects legacy assessment JSON. There is no automatic
conversion, claim approval, evidence promotion or runtime switch.

The accepted profile's `effectiveFrom: 2025-10-30` field retains its documented
publication-date meaning. ENG-003 enforces its existing lower date bound and the
Critical Controls `reviewDueAt: 2027-08-31` upper bound using only explicit score
time. This adapter neither revises those dates nor claims an NCSC effective date.

## Literal regression examples and the N/A difference

`test/fixtures/ncscAcceptedEvaluation.json` independently reauthors the useful
fourteen-question mix from `examples/ncsc-sme-gap-assessment.json` into the current
schema: three yes, seven partial, two no, one explicit unknown and one N/A claim.
Stable literal question IDs, responses and independent domain totals prevent
fixtures from simply repeating the adapter's mapping. Synthetic
`customer_asserted` evidence is represented only as `attested`, never verified
or substantiated. No narrative or customer evidence is imported.

The approved generic PROD-003 example A is the authoritative numeric golden.
The additional NCSC fixture uses independent arithmetic under that contract;
it is not a newly approved scoring policy or an official NCSC score:

| Scenario | Applicable questions | Lower / upper half-units | Attainment range | Completion | Provided evidence |
| --- | ---: | --- | --- | --- | --- |
| N/A claim pending | 14 | 13 / 17, denominator 28 | 46.4–60.7% | 12/14 = 85.7% | 11/14 = 78.6% |
| Exact N/A decision trusted | 13 | 13 / 15, denominator 26 | 50.0–57.7% | 12/13 = 92.3% | 11/13 = 84.6% |

Three yes responses earn six half-units; seven partial responses earn seven.
Each applicable unresolved question adds two possible upper units. The pending
N/A remains unresolved and applicable, so its maximum cannot be removed from the
denominator. An exact trusted decision excludes it and reproduces the existing
PROD-003 example A counts/range. A matching digest supplied solely by the caller
is insufficient to approve it. The trusted decision must match the exact
organisation, module, assessment revision, question, profile, scope and rationale.

All-attested evidence gives zero substantiated or tested coverage. Evidence,
impact and Critical Controls overlays cannot change attainment or completion.
Domain totals are rebuilt from leaves: Guide/Govern has 2 questions,
Identify/Understand 1, Prevent/Protect 7, Detect/Contain 2 and Respond/Recover 2.
Displayed domain percentages are never averaged to obtain the overall result.
All missing responses yield a provisional 0–100% range; an empty
applicable set after trusted exclusions yields Not scored and null percentages.
That numeric outcome does not authorise an organisation's scope exclusions.

## PR #172 evidence and remaining work

PR #172 contains legacy tenant/provider-bound persistence, runtime and UI work.
Its useful synthetic numeric intent is retained by the fixture and current
legacy tests. None of its Autotask membership, provider crosswalk, route or
storage assumptions is copied into this adapter. Dashboard Cyber Security
assessment eligibility must remain independent of provider purchases.

ENG-003 still reports remediation priority as `not_calculated` with reason
`priority_adapter_required`, and trend as `not_requested`. No old roadmap
formula, NCSC certification, formal risk score, maturity attainment or new
priority policy is inferred here. Catalogue statements, attribution and source
rights remain in the unchanged accepted publication for later report composition.

DATA-001 and later assessment-service integration must load current durable
tenant/organisation membership, permission, product/framework entitlement,
scope/evidence/risk provenance and trusted approval records coherently. Assessment
scope identifiers are supplied inputs, not authorisation. POR-008 supplies audit
wiring; a later report/issue workflow owns customer-safe projection and immutable
publication. This adapter does not require an Autotask account to score an
already-authorised dashboard assessment, and it does not bypass provider controls.

## Verification

From the repository root:

    npm test -- --runInBand test/ncscAssessmentEvaluator.test.js test/assessmentEvaluator.test.js test/ncscAcceptedFrameworkProfile.test.js test/ncscGapAnalysis.test.js
    node --check api/shared/assessmentEngine/ncscAssessmentEvaluator.js
    npm run validate:governance

Tests cover literal pending/approved goldens, five-domain arithmetic, missing
envelopes versus responses, zero applicable population, evidence independence,
exact tuple/module rejection, trusted-decision replay boundaries, input/snapshot
integrity, source temporal bounds and immutable canonical output. An isolated
process denies network and tenant/provider module imports and rejects clock or
randomness reads while the synthetic evaluation still succeeds.

These are source-level acceptance checks. They do not prove durable snapshot
authorisation, customer admission, live dashboard integration or issued reports.
