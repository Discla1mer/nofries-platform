# Customer journey acceptance

Split from #17 for #15. CI verifies application logic with synthetic providers; the release owner separately authorises the manual check below. This document performs no production operation.

## 1. Application tests (CI)

These run the production application code with synthetic identity, mail and
storage. They prove the logic of each step, not the live configuration.
`test/postReleaseJourneyCoverage.test.js` fails if a listed test is renamed or
removed.

| Step | Covered by |
|---|---|
| Fresh signup | `test/organisationSetup.test.js` — "verified organisation setup is server-owned, durable and grants no application authority"; `test/customerProductionJourney.test.js` — "actual production application serves signup and joins callback, terms, CSRF, receipt and returning status" |
| Correct organisation | `test/customerProductionJourney.test.js` — "display email and tenant login cannot replace the delivered invitation capability"; `test/ncscAssessmentRepository.test.js` — "canonical list uses bounded ASCII keysets and excludes every other tenant and organisation" |
| Assessment | `test/ncscAssessmentRepository.test.js` — "creation, bounded save and submit retain exact public state, supporting records, one quota charge and one audit per mutation" |
| Save | `test/ncscAssessmentRepository.test.js` — "partial patch preserves untouched responses, null deletes one answer and retained older rationale remains immutable"; `test/dashboardCrossFeatureAcceptance.test.js` — "one explicit save overlaps slow refresh, then navigation and fresh read resume the same saved record" |
| Sign out | `test/customerProductionJourney.test.js` — "production activation port composes with customer logout and denies customer or cross-origin administration" |
| Return | `test/customerProductionJourney.test.js` — "verified email repairs first login without an invitation cookie; returning login preserves the same identity" |
| Results | `test/ncscAssessmentSubmission.test.js` — "maps all response, evidence and risk facts with exact sealed revision/time and original provenance"; `test/customerTrialProductionComposition.test.js` — "actual retained page denies foreign bindings, extra authority hints, edits and cross-origin logout" |

## 3. Signed-in journey (opt-in, a person, about 15 minutes)

This is never run by the script or by CI. Opt in separately with the release
owner and use an approved test mailbox and organisation. It creates an account,
sends email, saves answers and submits an assessment. Do not put credentials in
CLI arguments or paste session data into release evidence.

Use a fresh approved test mailbox and recognisable synthetic organisation. Keep account identification in the private test-data plan, never in logs, URLs or public evidence.

| Step | Do | Pass when |
|---|---|---|
| 1. Fresh signup | Open `/signup`, enter the test address and the emailed code, fill in organisation details. | The code email arrives within 5 minutes, then an invitation email arrives. |
| 2. Correct organisation | Accept the invitation, complete Microsoft sign-in and MFA, accept the terms. | The dashboard names **your test organisation** and no other. No other customer's name or data appears anywhere. |
| 3. Assessment | Start the NCSC assessment and answer at least three questions, adding a rationale to one. | Answers stay on screen with no error. |
| 4. Save | Save the draft. | The assessment shows as in progress. |
| 5. Results | Complete the remaining questions, submit once, and open results. | Attainment and completion match the submitted answers. |
| 6. Sign out | Use the sign-out control, then open `/dashboard` again. | You are asked to sign in; no dashboard content shows. |
| 7. Returning user | Close the browser, reopen, sign in from `/login` and reopen the assessment and results. | The same organisation, saved answers and rationale, and submitted results remain available. |

Record each step as PASS or FAIL with time, expected outcome and the origin/path
of the page that failed. Strip query strings and fragments (invitation and auth
URLs can contain secrets); use test record IDs only where needed. Do not record
addresses, customer content, codes, cookies, tokens or unredacted screenshots.

Stop and treat it as a release failure if step 2 or 7 shows any other
organisation's name or data.

## Clean-up

Retain the synthetic account only under the release owner's test-data retention
plan. A completed journey has customer records and is **not** eligible for an
empty-signup reset. Use the separately approved cleanup procedure; this script
never deletes or resets anything.
