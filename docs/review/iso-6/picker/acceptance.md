# Paid assessment picker acceptance

Three local synthetic personas used the mounted Cyber Security picker on 19 November 2026. Each started an empty assessment, saved one answer, reopened the dashboard, resumed with one saved answer, submitted every question and reopened the sealed result from the picker. The run used Chromium 154.0.8037.57, a 375 × 812 viewport and axe-core 4.14.0.

| Persona or access condition | Observed outcome |
| --- | --- |
| IT manager preparing for certification | The question finder took the manager straight to the backup recovery question. They chose “In place with evidence” themselves and the sealed ISO 27001 readiness self-assessment retained that choice among 116 answers. [Backup question](it-manager-backup-question.png) |
| Owner whose customer asked for ISO 27001 | The owner recorded why externally built software was outside their scope. They reopened the results and found the reason beside the relevant control in the statement of applicability. All 116 answers were retained. [Applicability reason](owner-customer-evidence.png) |
| Consultant with two clients | Client A submitted 106 NIST CSF 2.0 answers. Switching to B removed A’s board. A’s old generation returned 403 and B’s current generation returned 404 for A’s saved ID. B saved a different answer using identical scope text. Switching back hid B’s draft and restored A’s original sealed response digest. [Client B after switching](consultant-second-client.png) |
| Flag off, exact entitlement present | The existing free assessment opened. Both paid collection requests returned 404. |
| Flag on, free entitlement only | Both paid choices were locked. Direct collection requests returned 403 for each framework. |

The run checked 15 settled views. Each measured 375 CSS pixels wide with zero axe violations for WCAG 2.0 and 2.1 A/AA. Both access controls made zero paid requests before the explicit refusal probes. The three boards offered no Copy or Print button and made zero export, quota or reservation requests. The issuance contract has no mounted issuer on these heads, so a positive export remains unverified. [Issuer design](https://github.com/Discla1mer/nofries-platform/pull/510)

The dashboard document, picker, question and results renderers, generation-bound asset identifiers, integrity checks, paid access decision and assessment lifecycle ran from the publications below. Sessions, module disclosures, generation rotation, storage transactions and event writes used local in-memory fixtures. The browser run therefore covers the mounted interface and lifecycle. It does not establish database isolation, production session handling or final HTTP disclosure checks. An earlier signed-in PostgreSQL run covered the backend on different heads with a test asset host. [Earlier run](../paid-journey.md)

## NCSC starting answers

Paid drafts on these heads retain a scope description. The NCSC scope digest binds the source tenant, organisation, assessment and capture time. Repeated text cannot establish that a paid draft covers the selected source population. The browser showed no suggestions and every newly started assessment had an empty answer set. No paid HTTP route calls the suggestion helper. When a server-owned scope binding is available, the helper also checks exact scope content, tenant, organisation, pinned publication, saved source revision and a valid submission seal. Its isolated positive tests supply that binding explicitly. They return “Needs confirmation” hints and leave the response set untouched. [Scope decision and security review dependency](https://github.com/Discla1mer/nofries-platform/issues/500#issuecomment-7020056926)

## Reproduce this assembly

| Source | Immutable head |
| --- | --- |
| Picker host #509, including the picker from #505 | `0fd17ef87847e57bb05f423829c12bb9febded8d`, #505 `667ed52aafff238a324eceff3dec2c0e6eeb49f4` |
| Paid access and records #507 | `d7247af1ac1eb1c60cb9f136e4a95d7f43be5b67` |
| ISO publication #506 | `dd1086a6990c54d390d42eef6f38d9594277a2a1` |
| Questionnaire #504 | `eefbde74b97eef5909345044f014e4168cff88ee` |
| Results and their stylesheet additions #503 | `5822b5e925e10758d1d71b7e6ea6f29e4630b13c` |
| Starting-suggestion dependency #508 | `0338890e845b4613572b812489e39516fa6419e7` |

From this review branch, with those Git objects available, prepare a disposable checkout. Make the repository dependencies available there and supply the path to axe-core 4.14.0 and a directory for synthetic evidence. The runner needs Playwright and Chromium. Set `CHROMIUM_PATH` to select a different installed executable.

```sh
assembly=$(mktemp -d)
git worktree add --detach "$assembly" 0fd17ef87847e57bb05f423829c12bb9febded8d
git -C "$assembly" restore --source=d7247af1ac1eb1c60cb9f136e4a95d7f43be5b67 -- api/shared/assessmentLifecycle/paidAssessments.js api/shared/ncscAssessmentService.js api/shared/appLifecycle/dashboardResourceAuthority.js
git -C "$assembly" restore --source=dd1086a6990c54d390d42eef6f38d9594277a2a1 -- api/shared/assessmentEngine/iso27001FrameworkProfile.js
git -C "$assembly" restore --source=eefbde74b97eef5909345044f014e4168cff88ee -- api/shared/protectedAssets/paidQuestionnaire.js
git -C "$assembly" restore --source=5822b5e925e10758d1d71b7e6ea6f29e4630b13c -- api/shared/protectedAssets/paidResults.js
git diff 42121c1da1bfa12cdec7a4e94162b6a6fc29de3e 5822b5e925e10758d1d71b7e6ea6f29e4630b13c -- app/dashboard.css | git -C "$assembly" apply
node scripts/tests/paid-picker-personas.cjs "$assembly" "$AXE_PATH" "$EVIDENCE_DIR"
```

## Revised publication fixture

The earlier screenshots and PostgreSQL runs identify the previous publication. A fresh in-memory browser run checked the revised #506 publication at `9222a86377d4195b3befaa0246e40036ac3c4c97` against the complete [reviewed profile reference](../../../../test/fixtures/paidIsoSuggestionPublication.json) on both paid creation and sealed readback. The IT manager and owner each completed 116 ISO answers. The consultant completed 106 NIST answers and switched clients. The flag-off and free-only controls passed. All 15 views measured 375 CSS pixels with zero axe violations. No assessment started with a suggestion or an answer.

This run used #509 `7d758650dab417f15f7c9d041c11d92931d5b199`, #507 `de4cf51e2b98d82c38dae41c5cd2f678536a1167`, #504 `7a08cd3a0ec55da706f1f1cb22877f72c8d10647` and #503 `2bbf5457f8b2dd3150dbbe0e19ce343f9c6a5370`. #509’s original results integrity pin refused the new script with 404. In a detached checkout, the verified #503 results pin `sha256-igK5Woag5xT1+bhWTLZXiOr9zklWBEsjnnVTR9Ran/Q=` admitted it. The three #507 runtime files used here are unchanged at its revised registration-test head `534b6a73f7ffdfede3b65c78bf03de564131c0cd`. Sessions and storage used the same in-memory ports described above. Fresh signed-in PostgreSQL evidence belongs to the separate assembled-head run in #500.
