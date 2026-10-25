# Internal assessment report preview

`api/shared/reporting/boardReportPreview.js` turns a complete generic assessment
input into a readable management preview. This is the REP-001-PREVIEW source
checkpoint. It does not implement issued reports, tenant-authorised access,
durable snapshots, download routes or live dashboard integration.

Both entry points invoke the existing ENG-003 `evaluateAssessment` function.
They accept original input and trusted registry dependencies, never a precomputed
score or a browser-supplied report object. No independent score arithmetic, AI
generation, network access, clock lookup or storage side effect is added.

```js
const {
    buildBoardReportPreview,
    renderBoardReportPreviewHtml
} = require('./api/shared/reporting/boardReportPreview');
const { createFrameworkRegistry } = require('./api/shared/assessmentEngine/frameworkProfileRegistry');
const { createAcceptedNcscFrameworkProfile } = require('./api/shared/assessmentEngine/ncscAcceptedFrameworkProfile');

// Synthetic usage from a repository-root script. A future runtime must derive
// source selection, authority and time independently of browser input.
const input = require('./test/fixtures/ncscAcceptedEvaluation.json').input;
const evaluatorOptions = {
    registry: createFrameworkRegistry([createAcceptedNcscFrameworkProfile()])
};
const presentation = { generatedAt: '2026-09-14T09:00:00.000Z' };
const preview = buildBoardReportPreview(input, evaluatorOptions, presentation);
const html = renderBoardReportPreviewHtml(input, evaluatorOptions, presentation);
```

The relative paths in this example assume execution from repository root.
`generatedAt` must be a canonical UTC timestamp with milliseconds, at or after
the assessment's `scoreAsOf`. It is explicit so identical inputs reproduce the
same preview. Unknown presentation fields are rejected. Evaluator validation
continues to own framework pins, input bounds and applicability decisions.

The frozen structured result carries:

- `audience: internal_preview`, `status: draft`, the preview contract version and
  supplied generation time;
- the entire evaluator provenance and its output digest, including organisation,
  assessment revision, framework/profile versions, rule versions, mapping,
  weight, scope population, evidence and risk snapshot digests;
- unchanged completion, attainment, evidence, remediation-priority and trend
  measures, together with framework-domain aggregates;
- overlapping follow-up question counts for unresolved responses, reported
  partial/absent implementation and missing current supporting evidence;
- fixed and result-specific limitations, including pending or approved
  exclusions and an explicit Not scored state for a zero denominator.

The HTML is standalone, with no script, remote asset, control or link. Separate
cards show response completion, implementation attainment, current supporting
evidence, and tested/observed evidence. Attestation is visible in the evidence
distribution and supplied-evidence count; it is not labelled documentation or
testing. A weighted upper bound is labelled as uncertainty, not achieved
performance. Completion means applicable questions have a yes, partial or no
response; it does not assert every control is implemented. Remediation priority
is not calculated, and trend is not assessed. No new risk ordering, action owner,
deadline or compliance determination is invented.

The existing evaluator does not carry reviewed narrative scope, customer display
names, raw evidence or approved action text. The preview therefore identifies
the source organisation and exact scope digest and explicitly notes that the
narrative scope/exclusions statement is absent. Domain headings are readable
versions of stable IDs, with the exact IDs shown immediately below; they are not
new official framework labels. Individual response payloads, reviewer identities
and applicability rationale digests are not projected.

The original input and trusted dependencies must be retained elsewhere to
reproduce a report. A digest is a change detector, not an access token, approval
or signature. This source module does not establish tenant access, evidence-file
verification, snapshot retention, approval state or customer admission. Runtime
integration must independently authorise source selection and bind the complete
organisation, revision and snapshot tuple. It must not accept caller-supplied
registries or treat the preview's draft flag as an approval system.

Run the source checks from repository root:

    npm test -- --runInBand test/boardReportPreview.test.js test/ncscAssessmentEvaluator.test.js
    node --check api/shared/reporting/boardReportPreview.js

All examples are synthetic. Source tests, static HTML inspection and any
separately recorded local render are distinct from real-browser, mobile,
runtime and issued-report acceptance. REP-001 and REP-003 remain open for those
full journeys.
