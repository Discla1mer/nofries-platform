# Paid assessment acceptance on a disposable build

Use synthetic local sessions and the profiles in issue [#500](https://github.com/Discla1mer/nofries-platform/issues/500). Record the SHA for each participating stream, the browser version, viewport, request status, and the screenshot or print artifact for each observation. Leave the source and target assessments available in the fixture for a fresh read. Never copy cookies or real customer records into the evidence.

## Reproducible checks on this branch

- Run `npm test -- --runInBand --runTestsByPath test/paidStartingSuggestions.test.js test/nistNcscCrosswalk.test.js test/dashboardSourceSelection.test.js test/ncscAssessmentSubmission.test.js test/ncscAssessmentSubmissionV2.test.js` for the suggestion projection and NCSC regressions.
- Run `node scripts/tests/paid-framework-journey.cjs` for ten requests against the default-off application. Before the paid runtime exists the same paths return 404 as unknown routes.
- On a combined fixture, use the script’s `fixtureTransport(harness, session)` with the authenticated in-process application. Run `checkLifecycle(call, profile)` for each entry in `profiles`. It reads the admitted publication, starts an empty record, saves one answer, checks incomplete submission, resumes, finishes, submits, and re-reads the sealed record. Keep the returned assessment ID for the browser and access checks.
- Run `checkDenied(call, profile, id, [404])` against the flag-off fixture. With the flag on, use a selected session lacking that exact tuple and the refusal statuses specified by the runtime. Repeat after revocation using the previously saved ID. Inspect the disposable database before and after denied operations and verify unchanged rows.

## Persona acceptance criteria

| Local persona | Action | Evidence to retain |
| --- | --- | --- |
| IT manager preparing for certification | Start both frameworks. On ISO, review the backup suggestion with its source, save one deliberate answer, leave, resume and finish. | Source revision and scope, visible “Needs confirmation”, empty answer before confirmation, resumed answer and sealed results. |
| Owner responding to a customer’s ISO 27001 request | From pricing, follow the roadmap. On an entitled fixture complete the ISO 27001 readiness self-assessment and open its results. | Distinguish the planned offer, readiness evidence and the accredited certification body. Verify the printed result names the organisation, scope and selected framework. |
| Consultant working with two clients | Use two organisations with identical scope labels, overlapping local assessment IDs and visibly different answers. Switch client while the first request is pending, then switch back. | Late replies, suggestions and results from the first client must stay out of the second client’s view, network responses and print output. Re-read each saved record under its own selection. |

For **each** framework exercise the full picker → start → save → fresh resume → submit → results journey at 375 CSS pixels. Run the repository’s axe tool on each settled view, record violations and horizontal overflow, and capture results at screen and print media sizes. With a current export decision, use the real Print control and check the print document against the sealed revision. Without that decision, verify that print stays unavailable and record the positive export test as blocked.

Source selection, exact-tuple asset admission, and export authorisation are runtime dependencies tracked in #500. A fabricated response, a matching scope description or a screenshot of public copy cannot establish a mounted pass.

## Signed-in local run on 19 November 2026

Chromium 154.0.8037.57 used the genuine #504 form at `a7698f1bde59098ab9bab74bca978c7ac9f759bd` and #503 results at `7ca84d4c8f9564eb69d0de76b2365cba0d23f0fe`. NIST came from main `42121c1da1bfa12cdec7a4e94162b6a6fc29de3e`. The ISO publication came from #506 at `dd1086a6990c54d390d42eef6f38d9594277a2a1`.

The local assembly used #507 at `d2c1724de7017f9d66477c9c61456f36900ddfac`, including #502, on a disposable PostgreSQL 17.11 cluster. The signed-in fixture called the production HTTP collection and start routes. The real questionnaire then saved one answer, resumed from a fresh HTTP read, saved the rest and submitted. The real results renderer opened the sealed revision. Each start, save, resume, submit and result read returned HTTP 200. Only the test host supplied the protected assets and affirmative export callback. Print stayed unavailable without that callback.

Run `checkPaidBrowser({ browser, call, publication, assetRoot, axePath, outputDirectory })` from `scripts/tests/paid-framework-browser.cjs` in the combined fixture. Supply Chromium, the selected fixtureTransport, the collection’s published profile, the checkout with the two protected renderers, the local axe-core script and an existing evidence directory. It captures the form, resume, results, measurements and A4 board from the Print control.

| Profile | Answers after first save / final save | Axe 4.14.0 at 375px | Local evidence |
| --- | --- | --- | --- |
| NIST CSF 2.0 | 1 / 106 | No WCAG 2 A/AA or 2.1 AA violations on form, resumed form or results. Each measured 375px. | [Form](nist-questionnaire-375.png), [resume](nist-resumed-375.png), [results](nist-results-375.png), [print](nist-component-board.pdf), [measurements](nist-component.json) |
| ISO 27001 readiness self-assessment | 1 / 116 | No violations under the same rules. Each measured 375px. | [Form](iso-questionnaire-375.png), [resume](iso-resumed-375.png), [results](iso-results-375.png), [print](iso-component-board.pdf), [measurements](iso-component.json) |

**Friction addressed in the synthetic scenarios.** The IT manager can identify the specific backup recovery check still needed from the source revision. The owner can distinguish planned readiness questions from the customer’s request for certification in the separate roadmap draft (#501). The consultant gets no suggestions on a client switch until the exact client, source revision and scope match. The unit tests exercise the first and third behaviours with real NCSC lifecycle envelopes; the owner’s public copy was checked in Chromium. Mounted suggestion display and client switching still need the combined host.

**Access and separation.** Ten focused native cases passed across the two profiles, including the six ISO-6 browser/access cases. Signed-in accounts received 404 on all five operations with the flag off and 403 with the flag on and only free access. Neither refusal wrote a paid revision. Two additional consultant cases passed. For each framework, the same consultant created records with identical IDs and scope text under two clients. After switching, the stale generation returned 403 and the other client's record initially returned 404. Different answers remained intact after switching back.

**Open integration checks.** #505 at `667ed52aafff238a324eceff3dec2c0e6eeb49f4` still lacks the admitted asset host. The browser tests above start at the authorised collection and use test asset delivery. Repeat through the real picker and export decision when available. The source-scope binding for suggestions also remains unimplemented in #500. Independent security review is required for those session, entitlement and data paths.
