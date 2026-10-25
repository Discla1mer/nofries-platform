# Retained board-report export compatibility

This technical review records two reproducible source gaps in the existing
report implementation. It introduces no report runtime or replacement renderer.
The review used synthetic data on 17 October 2026; all original branches and
reporting holds remain unchanged.

## Source boundaries

Qualified main `f48ca3a052e65341f24f2d91f346b00d4ba27d32` contains the pure,
unmounted assessment preview. Retained report history and HTML/PowerPoint
downloads are not on that main revision. Reuse the existing proposals:

| Proposal | Frozen head | Relevant source |
| --- | --- | --- |
| [PR379](https://github.com/Discla1mer/NoFries/pull/379) | `112a016f1c957877cebbfe7f6d6bc123cc0b1ce1` | Isolated draft snapshot builder/verifier; exports remain unmounted. |
| [PR415](https://github.com/Discla1mer/NoFries/pull/415) | `cbd3ac09b810366e868c1e34fd690b481ab80944` | Assessment and presentation source; parts separately reused by PR424. |
| [PR417](https://github.com/Discla1mer/NoFries/pull/417) | `594ad2986ec9cf626b1a1d5ada4c9ff561aa3ed6` | Retained draft reports, HTML/PPTX generation and downloads. |
| [PR422](https://github.com/Discla1mer/NoFries/pull/422) | `d041dbe9eee414b00d2cce6f1076f92e0acb55da` | Held composition; PR423/424 do not include its Board runtime. |

These exact heads' existing CI and previews remained successful at readback.
They are historical candidate results, not qualification against current main.
[The retained reconciliation](https://github.com/Discla1mer/NoFries/issues/17#issuecomment-6229319145)
preserves the original findings and holds. The
[bounded review claim](https://github.com/Discla1mer/NoFries/issues/17#issuecomment-6230273954)
and [one-file publication scope](https://github.com/Discla1mer/NoFries/issues/17#issuecomment-6230332406)
authorize this evidence work only.

## Editable PowerPoint table discriminator

At [PR417's renderer line 196](https://github.com/Discla1mer/NoFries/blob/594ad2986ec9cf626b1a1d5ada4c9ff561aa3ed6/api/shared/reporting/boardReviewPptx.js#L196),
the domain table uses `${NS_A}/table` for `a:graphicData/@uri`. Because `NS_A`
ends in `/main`, this emits
`http://schemas.openxmlformats.org/drawingml/2006/main/table`.

The table discriminator must instead be
`http://schemas.openxmlformats.org/drawingml/2006/table`. Microsoft documents
that Office chooses the graphic content handler from this identifier; it is
distinct from the DrawingML element namespace, which must retain `/main`.
[Microsoft's graphicData specification](https://learn.microsoft.com/en-us/openspecs/office_standards/ms-oe376/f58e82a5-5590-4e36-b178-e12989960415).

The synthetic mixed-assessment deck contains the table XML and all its values,
but the independently installed `python-pptx 1.0.2` consumer reports
`has_table=False`; accessing `.table` raises `ValueError`. Correcting only this
attribute in an in-memory copy produces `has_table=True`, a native table shape,
and six rows by three columns, including `Guide and Govern`. The original bytes
are unchanged. Native desktop PowerPoint rendering has not been tested.

The existing [PPTX tests](https://github.com/Discla1mer/NoFries/blob/594ad2986ec9cf626b1a1d5ada4c9ff561aa3ed6/test/boardReviewPptx.test.js#L95)
check ZIP validity, relationships, geometry, `<a:tbl>` and text, but omit this
type discriminator. Those passing checks therefore do not establish editable
table recognition. The bounded owner fix is the single table attribute plus a
regression assertion using the existing package-inspection tests. No new runtime
dependency or global namespace change is needed.

To reproduce against an existing synthetic deck using an already available
`python-pptx` installation (no dependency is added by this note):

```python
from io import BytesIO
from zipfile import ZipFile
from pptx import Presentation

original = open("board-review-synthetic.pptx", "rb").read()
bad = b'uri="http://schemas.openxmlformats.org/drawingml/2006/main/table"'
good = b'uri="http://schemas.openxmlformats.org/drawingml/2006/table"'
table = next(s for slide in Presentation(BytesIO(original)).slides
             for s in slide.shapes if s.name == "Editable domain measures")
assert table.has_table is False
changed, replacements = BytesIO(), 0
with ZipFile(BytesIO(original)) as source, ZipFile(changed, "w") as target:
    for entry in source.infolist():
        content = source.read(entry.filename)
        replacements += content.count(bad)
        target.writestr(entry, content.replace(bad, good))
assert replacements == 1
table = next(s for slide in Presentation(changed).slides
             for s in slide.shapes if s.name == "Editable domain measures")
assert table.has_table and len(table.table.rows) == 6
assert len(table.table.columns) == 3
```

This is a diagnostic control, not an instruction to rewrite retained downloads.
A corrected renderer affects new generation only. Previously retained artifacts
must remain immutable and require their own governed treatment if correction is
ever needed.

## Retained document-builder evolution

The [existing P1](https://github.com/Discla1mer/NoFries/pull/417#discussion_r4259959464)
concerns [sourceReader's current-builder comparison](https://github.com/Discla1mer/NoFries/blob/594ad2986ec9cf626b1a1d5ada4c9ff561aa3ed6/api/shared/appLifecycle/postgresBoardReviewRepository.js#L193).
Each retained read rebuilds the document with the currently loaded builder and
requires complete equality with the stored document.

An isolated module-injection probe reused the existing repository test's memory
transaction fixture and a submitted revision-2 synthetic assessment. Its report
has 50.0% implementation and 0.0% current evidence. It compared:

| Controlled change | List, read, exact retry, HTML download, PPTX download |
| --- | --- |
| HTML/PPTX renderer functions throw if called | All five succeed with exact original bytes; both renderers are called zero times. |
| Builder normalizes scope CRLF to LF and recomputes the document digest | All five reject with `board_review_unavailable` / 503. |

Both documents pass the unchanged document verifier. Contract, assessment
revision/digest, context, submitted snapshot and figures remain the same; only
scope display line endings and the resulting document digest differ. Failed
operations issue only SELECTs and preserve the fixture's retained state. Fresh
generation/read with the evolved builder succeeds, and the original repository
still reads the original report. The probe makes zero network attempts.

This counterfactual demonstrates the known compatibility risk, not a current-main
or production outage. Pure HTML/PPTX rendering changes do not trigger it, so the
table discriminator repair does not require changing document construction.
Before evolving that construction, the report owner must retain verification and
reconstruction of supported old document/snapshot/evaluator contracts. Removing
source checks or regenerating stored artifacts is not a resolution. The exact
compatibility policy and reviewed change remain owner work.

## Verification and retained evidence

Unchanged main passed 49 preview/evaluator tests. Unchanged PR417 passed 183
document, PPTX, repository, service and client tests. These are focused synthetic
checks, not a repeated full baseline or native PostgreSQL/RLS proof.

Existing Chromium 151 passed 12 HTML cases: mixed, unknown, unsubmitted and long
name/scope inputs at 320, 390 and 1440 pixels. There was no page overflow, browser
error or network request. Available disclosures received visible Tab focus,
opened with Enter and closed with Space. Print media exposed the full prompts;
the generated four-page A4 PDF retained final provenance text. These results
cover HTML only and do not qualify the defective PPTX table.

The saved environment holds runnable probes, synthetic exports and receipts in
`/workspace/report-validation-20261017/`. No customer data is included.

| Artifact | SHA-256 |
| --- | --- |
| `pptx-table-diagnostic.py` | `2f122e422d56b1fb90130c6fb7f8c9dcb0fc93b1897408e4c865fad6aaec8b37` |
| `pptx-table-diagnostic.json` | `f647c453e0d648f3a9c3eba5e4a1976e5cedb3e5f5cc4a9e7ed7c1176f848e83` |
| `compatibility/retained-builder-probe.cjs` | `cd8acefd325dbb8a942af5a7fd65260ecb354d126c4e97ee7ff978becbf8645d` |
| `compatibility/retained-builder-result.json` | `177cf5487c14c913668967b223f06d3307ce4b9366711d33010e2dce9b9cd0c3` |

Independent review reproduced both diagnostics and verified all 1,191 archived
PR417 blobs against its exact commit. The compatibility rerun differs only in
the hash containing randomly generated fixture audit identifiers. The synthetic
PPTX is defect evidence, not a verified usable editable-report deliverable.

## Remaining owner prerequisites

Correct and qualify the table discriminator on the coordinated report branch.
Resolve the existing builder-compatibility finding before accepting compatible
retained-history evolution. Preserve the separate
[issued-only Viewer panel finding](https://github.com/Discla1mer/NoFries/pull/417#discussion_r4259959475).
The held schema/grant and paired recovery prerequisites remain recorded in the
[report rollout decision](https://github.com/Discla1mer/NoFries/issues/17#issuecomment-6148931244).

Sole integration/release owner `01a12d38-b325-74cb-a810-1969e977502d` retains
implementation coordination, actual-main composition and any later release.
This note lifts no PR379/415/417/422, PR460, PR467 or other specific hold. No
source fix, migration, merge, deployment, issuance, live download, new service,
credential, permission, spend or customer acceptance is claimed.
