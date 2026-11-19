# Paid assessment acceptance on a disposable build

Use synthetic local sessions and the profiles in issue [#500](https://github.com/Discla1mer/nofries-platform/issues/500). Record the SHA for each participating stream, the browser version, viewport, request status, and the screenshot or print artifact for each observation. Leave the source and target assessments available in the fixture for a fresh read. Never copy cookies or real customer records into the evidence.

## Reproducible checks on this branch

- Run `npm test -- --runInBand --runTestsByPath test/paidStartingSuggestions.test.js test/nistNcscCrosswalk.test.js test/dashboardSourceSelection.test.js test/ncscAssessmentSubmission.test.js test/ncscAssessmentSubmissionV2.test.js` for the suggestion projection and NCSC regressions.
- Run `node scripts/tests/paid-framework-journey.cjs` for ten requests against the default-off application. Before the paid runtime exists the same paths return 404 as unknown routes.
- On a combined fixture, use the script’s `fixtureTransport(harness, session)` with the authenticated in-process application. Run `checkLifecycle(call, profile)` for each entry in `profiles`. It reads the admitted publication, starts an empty record, saves one answer, checks incomplete submission, resumes, finishes, submits, and re-reads the sealed record. Keep the returned assessment ID for the browser and access checks.
- Run `checkDenied(call, profile, id, [404])` against the flag-off fixture. With the flag on, use a selected session lacking that exact tuple and the refusal statuses specified by the runtime. Repeat after revocation using the previously saved ID. Inspect the disposable database before and after denied operations and verify unchanged rows.

## Mounted browser observations still required

| Local persona | Action | Evidence to retain |
| --- | --- | --- |
| IT manager preparing for certification | Start both frameworks. On ISO, review the backup suggestion with its source, save one deliberate answer, leave, resume and finish. | Source revision and scope, visible “Needs confirmation”, empty answer before confirmation, resumed answer and sealed results. |
| Owner responding to a customer’s ISO 27001 request | From pricing, follow the roadmap. On an entitled fixture complete the ISO 27001 readiness self-assessment and open its results. | Distinguish the planned offer, readiness evidence and the accredited certification body. Verify the printed result names the organisation, scope and selected framework. |
| Consultant working with two clients | Use two organisations with identical scope labels, overlapping local assessment IDs and visibly different answers. Switch client while the first request is pending, then switch back. | Late replies, suggestions and results from the first client must stay out of the second client’s view, network responses and print output. Re-read each saved record under its own selection. |

For **each** framework exercise the full picker → start → save → fresh resume → submit → results journey at 375 CSS pixels. Run the repository’s axe tool on each settled view, record violations and horizontal overflow, and capture results at screen and print media sizes. With a current export decision, use the real Print control and check the print document against the sealed revision. Without that decision, verify that print stays unavailable and record the positive export test as blocked.

Source selection, exact-tuple asset admission, and export authorisation are runtime dependencies tracked in #500. A fabricated response, a matching scope description or a screenshot of public copy cannot establish a mounted pass.

## Component run on 19 November 2026

Chromium 154.0.8037.57 used the genuine #504 form at `a7698f1bde59098ab9bab74bca978c7ac9f759bd` and #503 results at `7ca84d4c8f9564eb69d0de76b2365cba0d23f0fe`. NIST came from main `42121c1da1bfa12cdec7a4e94162b6a6fc29de3e`. The ISO publication came from #506 at `dd1086a6990c54d390d42eef6f38d9594277a2a1`.

Both runs opened a synthetic created record, selected and saved the first answer, reopened the form from that saved record, answered every remaining question in the browser, saved and submitted. The real results mount received the sealed test envelope. The board print control was unavailable without the export callback. A synthetic affirmative callback enabled capture of the A4 document. The fixture supplied in-memory reads and writes. There was no application session, picker, real export decision or database in this run.

| Profile | Answers after first save / final save | Axe 4.14.0 at 375px | Local evidence |
| --- | --- | --- | --- |
| NIST CSF 2.0 | 1 / 106 | No WCAG 2 A/AA or 2.1 AA violations on form, resumed form or results. Each measured 375px. | [Form](nist-questionnaire-375.png), [results](nist-results-375.png), [print](nist-component-board.pdf), [measurements](nist-component.json) |
| ISO 27001 readiness self-assessment | 1 / 116 | No violations under the same rules. Each measured 375px. | [Form](iso-questionnaire-375.png), [results](iso-results-375.png), [print](iso-component-board.pdf), [measurements](iso-component.json) |

**Friction addressed in the synthetic scenarios.** The IT manager can identify the specific backup recovery check still needed from the source revision. The owner can distinguish planned readiness questions from the customer’s request for certification in the separate roadmap draft (#501). The consultant gets no suggestions on a client switch until the exact client, source revision and scope match. The unit tests exercise the first and third behaviours with real NCSC lifecycle envelopes; the owner’s public copy was checked in Chromium. Mounted suggestion display and client switching still need the combined host.
