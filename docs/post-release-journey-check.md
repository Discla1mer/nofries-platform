# Post-release customer journey check

Three layers prove the customer journey. Only the last one involves a real
person, real mail and real Microsoft sign-in.

| Layer | When | Who | Writes data? |
|---|---|---|---|
| 1. Application tests | Every pull request (CI) | Automated | No (synthetic providers) |
| 2. Post-release smoke | Straight after a release | Automated script | No, by default |
| 3. Signed-in journey (opt-in) | Only when explicitly selected by the release owner | A person | Yes: one test account |

A failure in layer 2 or 3 means: hold further releases and take the rollback
decision to the release owner.

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

## 2. Post-release smoke (automated, read-only)

```sh
node scripts/post-release-smoke.js --base-url https://<production origin> --expect-sha <released commit SHA>
```

Every probe is an unauthenticated `GET` with no cookies and no redirect
following. Each probed route was verified against the production application to
make no durable write; the API rate limiter only counts requests in memory. It
checks:

- `/api/health` is `ok`, serves the expected release SHA, and `/release.json` agrees.
- `/signup`, `/login` and `/dashboard` load.
- Signup state starts at `create_account` for the provider selected by the served
  `/signup` page (legacy or external); organisation setup is available. Both state
  endpoints are read, but a healthy inactive provider cannot hide a broken selected one.
- Session, dashboard and NCSC assessment APIs exist and return `401` when signed out.

Exit code `0` means pass, `1` means a check failed and `2` means bad arguments.
Every check has a numbered PASS/FAIL line and each exact requested URL with its
HTTP status. A zero status is labelled NETWORK/TIMEOUT failure. For a check with
alternative routes, one healthy route is sufficient; all probed URLs are shown.
Response bodies, redirect destinations, cookies and transport error text are
never printed. Base URLs containing credentials, query strings or fragments are
rejected. `--allow-http` is for a local synthetic fixture only.

Example failure (synthetic fixture, not production evidence):

```text
FAIL step 11: assessment API is wired and requires sign-in (expected HTTP 401, got 404)
  GET https://example.invalid/api/dashboard/ncsc/assessments -> HTTP 404
FAIL post-release smoke: 10/11 checks passed.
```

If `--expect-sha` is omitted, smoke checks only that health and the release
manifest agree; pass the full released SHA for release acceptance.

`--include-sign-in-redirect` also checks that sign-in redirects to Microsoft.
**That probe is not read-only**: each run stores a short-lived sign-in
transaction record. Use it only when sign-in configuration changed.

The smoke check proves the routes are wired. It cannot prove sign-in, mail,
organisation binding, saving or results; that is layer 3.

## 3. Signed-in journey (opt-in, a person, about 15 minutes)

This is never run by the script or by CI. Opt in separately with the release
owner and use an approved test mailbox and organisation. It creates an account,
sends email, saves answers and submits an assessment. Do not put credentials in
CLI arguments or paste session data into release evidence.

Use a new address that has never signed up, for example a plus-address on a
mailbox you control (`name+release-YYYYMMDD@domain`). Do not reuse the earlier
empty signup. Use a recognisable organisation name such as
`Release check YYYY-MM-DD`. Record the address; it is the only account to clean up.

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
