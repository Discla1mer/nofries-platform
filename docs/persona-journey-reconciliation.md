# Frozen persona source reconciliation (#58)

Source: `codex/persona-journey-fixes-20261104` at **9c84dfc70c66d6450423cbbfde8f1f0ab91fe7c7**, exactly 44 changed files. This is a selective refresh, not acceptance of every frozen hunk.

Review/release order: current public main `00bf0f0f85990bc95f9bf060b612e934ea60894b` → existing full submission review #27 (`50711d315d8049f4c05b1345bcd9ecba5d961ec3`) → signup #66 → labels/guidance #67 → assessment journey. No other author's branch is changed. Fry must retarget/requalify each dependent slice after its predecessor lands. No production wiring or release authority is added.

## Preserved invariants and deliberate exclusions

- The scope declaration is chosen explicitly at creation. List labels truncate only the display projection to 160 Unicode code points; the complete supporting record, actor/time provenance, digest and audit binding remain immutable through save and submit. Attempts to include replacement scope in save/submit are rejected. A different scope requires a new assessment through the existing list/create lifecycle.
- #27's full review of all answers, scope, readiness, N/A explanations, edit/return and explicit Save and submit remains the only confirmation. The frozen Unknown/N/A-only confirmation is superseded, not layered on top.
- Access denial still clears saved and unsent assessment data. The frozen recovery textarea is excluded: a dirty rationale may contain previously saved private text, so it is not necessarily safe after access revocation.
- The frozen inline different-scope shortcut is excluded: it does not reset conflict/currentness or invalidate pending reads. We retain the existing guarded list/create path and explain that a different scope needs a new record. No automatic default scope is accepted for the user.
- Save retains idempotency keys, captured edit generations, byte batching, quota and recovery gates. The mounted Save control remains disabled while pending; review-triggered saving retains #27's original presentation lifecycle. Detached callbacks cannot act on a replacement view.
- Results next steps and the copyable provider summary use only saved responses. They explicitly describe reported gaps, not a calculated risk ranking. Server evaluation and its source disclosures are retained. Missing results can be retried with a read only.
- Broad service/subscription wording, legal/privacy changes and homepage/assistant design are outside these focused signup/assessment slices; they remain in the frozen source for their owners. No unreviewed contractual/service claim is imported.

## Active work overlap

| Work | Resolution |
|---|---|
| #61 writer fence | No changed paths or backend signup writes. This work does not activate a reset or weaken the fence. |
| #47 admin portal | No changed paths against its refreshed `685636a` head. Its reset/fence dependency remains separate. |
| #42 / #60 enquiry | No enquiry runtime, limiter or public homepage changes. #66 minimally changes signup expectations in `test/customerStaticBuild.test.js` and `test/organisationSetupHttp.test.js`; compare shared tests again after other work lands. |
| #43 homepage CTA | Preserve current-main homepage and its assertions. Only the signup assertion hunks above are ported. |
| #27 submission review | Stack directly on refreshed #27; preserve all review behavior and tests. Amend only relevant save focus, guidance/results and read-only summary expectations in the final slice. |
| #50 browser selectors | Existing shared guidance/text browser scripts remain with their owner. New persona scripts use visible controls and do not overwrite that work. |
| #32 / private #723 visual | No CSS, logo, homepage or visual browser-script edits. Validate against inherited #27/current-main styles; owners must rerun the same journeys after visual integration. |
| #713 / production releases | No changes to release workflows, pinned files, release preparation, environment, permissions, secrets or either main. |

## Disposition of all 44 frozen files

“Adapted” means a narrow port preserving newer main/#27 behavior. “Deferred” is not a claim that the frozen change has shipped or passed the refreshed stack's checks.

| Frozen file | Disposition |
|---|---|
| `api/shared/ncscAssessmentService.js` | #67: bounded display-only scope label. |
| `api/shared/ncscQuestionnaireMetadata.js` | #67: reading aids; canonical questions/options/scoring unchanged. |
| `api/shared/protectedAssets/dashboardRegistry.js` | Deferred: broad service descriptions need separate product review. |
| `api/shared/protectedAssets/dashboardShell.js` | Deferred: broad subscription/service wording and shell changes. |
| `api/shared/protectedAssets/ncscAssessmentClient.js` | #67: closed optional label/reading-aid validation and old-response compatibility. |
| `api/shared/protectedAssets/ncscQuestionnaire.js` | Adapted final slice: mounted Save/focus, scope labels, reading aids, saved-result next steps/read retry. Full #27 review retained. Unsafe denied-draft/inline scope transitions excluded; broad progress copy, default scope, navigation relocation and validation redesign deferred. |
| `api/shared/protectedAssets/organisationPicture.js` | #67: recognisable scope/date labels; detailed source records retained. |
| `app/dashboard.css` | Deferred to #32/#723; inherited #27 review styles unchanged. |
| `docs/ncsc-assessment-api.md` | #67: display label contract, exact detail retained. |
| `home.css` | Deferred to visual owners #32/#723. |
| `index.html` | Preserve current main; frozen homepage superseded by newer wording and #42/#43 ownership. |
| `js/home.js` | Deferred with homepage work; no homepage dialog rewrite. |
| `js/organisation-setup.js` | #66: signup steps, validation, focus and in-memory email context. |
| `js/shared-assistant.js` | Deferred with assistant/visual work. |
| `login.html` | #66: matching accessible signup markup and text. |
| `privacy.html` | Deferred: legal/privacy wording overlaps #42 and needs separate review. |
| `roadmap.html` | Deferred: broader public copy. |
| `scripts/build-ncsc-questionnaire-preview.js` | #67: minimal synthetic bounded scope label only; no replacement of #27 review instrumentation. |
| `scripts/tests/dashboard-assessment-experience-browser.cjs` | Deferred with shell wording; unchanged. |
| `scripts/tests/ncsc-question-guidance-browser.cjs` | Preserve #27/#50 ownership; new persona journey checks guidance layout. |
| `scripts/tests/ncsc-question-text-browser.cjs` | Preserve #50 ownership; unchanged. |
| `scripts/tests/persona-questionnaire-browser.cjs` | Adapted final slice: strict Chromium CDP, full #27 review, save/submit/results, 320px and measured 200% text. |
| `scripts/tests/persona-signup-browser.cjs` | Adapted #66: strict Chromium CDP and per-form/error-state layout matrix. |
| `scripts/tests/public-footer-assistant-clearance-browser.cjs` | Deferred to #32/#723. |
| `shared-assistant.css` | Deferred to #32/#723. |
| `terms.html` | Deferred: legal/service wording needs separate review. |
| `test/assessmentExplanationIntegration.test.js` | #67: selected record identity/date assertions. |
| `test/customerStaticBuild.test.js` | #66: minimal NZBN markup expectations; current homepage retained. |
| `test/dashboardLoader.test.js` | Deferred with shell/homepage changes. |
| `test/dashboardPublicHomepage.test.js` | Preserve current-main expectations; no frozen rollback. |
| `test/dashboardShell.test.js` | Deferred with shell wording. |
| `test/fixtures/dashboardDom.js` | Frozen broad fixture rewrite not needed by retained assertions; unchanged. |
| `test/homeDialogInteraction.test.js` | Deferred with homepage dialog work. |
| `test/integration/ncscAssessmentPostgres.js` | Adapt only the closed list-field expectation for #67's display label; preserve #27's complete submission review integration. Native CI remains required. |
| `test/ncscAssessmentList.test.js` | #67: legacy/malformed/bounded-page labels plus immutable scope hash and hostile replacement commands. |
| `test/ncscAssessmentService.test.js` | #67: closed projection and complete detail tests. |
| `test/ncscQuestionnaire.test.js` | Adapted #67/final slice: new metadata contract, retained #27 regressions, mounted Save, read-only summary and results retry. |
| `test/ncscQuestionnaireMetadata.test.js` | #67: frozen display aids, unchanged accepted questions and malformed-input rejection. |
| `test/organisationPicture.test.js` | #67: scope/date labels, source disclosures and distinct same-time records. |
| `test/organisationSetupClient.test.js` | #66: signup regression coverage. |
| `test/organisationSetupHttp.test.js` | #66: minimal novalidate form assertion. |
| `test/server.test.js` | Preserve current-main homepage expectations; no frozen copy rollback. |
| `test/sharedAssistant.test.js` | Deferred with assistant changes. |
| `test/starterPrivacyNotice.test.js` | Deferred with legal/privacy changes. |

## Verification meaning

Normal public CI executes the full application, native PostgreSQL/tenant-isolation and governed dependency checks. Chromium journeys run separately with the commands below and fail if the browser is absent; they do not add a browser prerequisite to existing application/package verification. No test is conditionally skipped and no workflow, package manifest or dependency is changed.

```sh
CHROMIUM_EXECUTABLE_PATH=/path/to/installed/chromium node scripts/tests/persona-signup-browser.cjs
CHROMIUM_EXECUTABLE_PATH=/path/to/installed/chromium node scripts/tests/persona-questionnaire-browser.cjs
```

Both commands output a JSON receipt including browser version, viewport, measured text sizes, stage layout, and (for assessment) exact write/scroll/focus observations. Run both again after stack retargeting or visual integration.

Signup checks the actual HTML/JS/CSS against a loopback synthetic legacy-code service, including formatted code, optional NZBN, linked errors and every step at 1280/320px with 100%/200% measured text. It does not exercise an external identity provider, email delivery or real account creation.

Assessment checks actual renderer/CSS and synthetic transport: delayed/immediate double-click Save, exact single writes and focus/scroll, full review/cancel/explicit submit, next steps, read-only result retry, and an existing submitted fixture calculated with the real server evaluator. Interactive preview submission itself does not calculate results; the calculated-results render is a separate fixture check. Text scaling changes font tokens only and persists across asynchronous rendering; viewport/device scale and layout units are unchanged.

Hosted run links, immutable heads and final review receipts are recorded on the PRs and private coordination issue #686. Passing these synthetic checks does not prove production authentication, database deployment, physical-mobile behavior or compatibility with visual changes that are not in the stack.
