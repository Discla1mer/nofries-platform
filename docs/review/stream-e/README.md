# Stream E review evidence

These are real Chromium screenshots at a 375 × 844 CSS-pixel viewport, using
synthetic loopback fixtures and the production documents, JavaScript and CSS.
No real identity provider, acceptance, customer data or email is involved.

| Step | Screenshot |
| --- | --- |
| Default-off sign-up | [Full details](01-flag-off-signup.png) |
| Flag-on sign-up | [Organisation and authority](02-flag-on-signup.png) |
| Separate deliberate acceptance | [Terms step](03-terms.png) |
| Existing questionnaire | [Question one](04-question-one.png) |
| Result before personal details | [First result](05-first-result.png) |
| Board/insurer summary gate | [Details required](06-summary-gate.png) |
| Later collection | [Name, role and address](07-later-details.png) |
| After save and reload | [Summary available](08-summary-ready.png) |
| D suggestions before capture | [Readable questions](09-questionnaire-readable.png) |
| Questionnaire export gate | [Details required for Copy/Print](10-questionnaire-export-gate.png) |
| Persisted completion confirmed | [Questionnaire exports available](11-questionnaire-exports-ready.png) |

Actual whole-page Chromium print PDFs:
[E flag off](questionnaire-flag-off.pdf),
[before capture](questionnaire-before-details.pdf),
[after save](questionnaire-after-details.pdf), and
[after reload](questionnaire-after-reload.pdf).

Reproduce from the repository root with `node scripts/tests/stream-e-browser.cjs`.
It requires Playwright, Chromium and `pdftotext`; set `CHROMIUM_EXECUTABLE_PATH`
if Chromium is not at `/usr/bin/chromium`. Output defaults to `/tmp/stream-e-browser`; the
runner rejects an output directory inside the repository. The checked-in
[receipt](receipt.json) records the browser assertions, one details write and
one audit event, persisted completion reads, and print inclusion assertions,
with no page errors, external requests or unmatched routes.

The browser runs the sign-up steps through question one, then loads a synthetic
submitted result produced by the existing evaluation engine. It does not pretend
to complete all 14 questions or authenticate against a provider. The native
PostgreSQL tests separately create, save and submit an assessment through the
real authenticated HTTP handlers, then exercise the gate and immutable save.
The browser backend writes its synthetic supplemental row to a file outside the
repository. The production details service reloads and validates that row's hash
and agreement links on each read. A successful save must be followed by a ready
read before the UI unlocks exports. Reload checks persisted completion again.
An unconfirmed-save case returns a synthetic 503 after a successful write; retry
and reload recover the same record. Cancel saves nothing. This fixture does not
replace the separate native PostgreSQL transaction/RLS checks.

## Integration with Stream D

PR #465 is stacked on #464. Merge order is #464, then retarget/rebase #465 onto
main and verify its exact resulting head before merging. Neither PR is merged
by this work. D's patch is unchanged by its rebase onto current main; E's diff
against D contains the deferred-details feature and this export integration.
E's unpublished evidence migration is numbered 0028 because main already has
0027 for contact-request retention.

D has no feature flag. Its nine suggestions remain readable after the first
result. Only exact `NOFRIES_DEFER_STARTER_DETAILS=true` advertises the new
questionnaire export gate in the authenticated session. The existing trusted
details service determines whether this organisation has outstanding details.
The gate creates Copy/Print controls only after a verified ready response; the
suggestions render regardless. Before that response, print CSS omits the entire
questionnaire section from app-triggered whole-page printing and browser print.
Read failures leave exports withheld. The PDF checks verify all nine questions
and the footer are absent before capture and present after save/reload.

With E's flag off, D's Copy/Print behavior is unchanged, even for a previously
enrolled deferred account with outstanding details. The browser covers that
case, real clipboard output, the native beforeprint event, and flag-on capture.
Readable suggestions can still be manually copied or captured in screenshots;
this is an application export gate, not a secrecy boundary.

Question order, answer controls, scoring, revisions, submission, sign-in and
agreement acceptance stay unchanged. A persisted submitted assessment in the
selected organisation is a first result; drafts do not qualify. Existing E
board-summary and service gates continue to follow the retained agreement
policy. The authenticated contact-request API enforces its gate independently.
Public contact pages and the existing general results summary stay available.
