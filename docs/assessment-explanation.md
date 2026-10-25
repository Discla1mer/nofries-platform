# Explain one saved result with Ask Fry

In the protected Overview, select a submitted cyber assessment and choose **Explain this saved result**. The local Ask Fry panel offers **Saved range**, **Unresolved answers** and **Framework starting actions**. Its explanation describes only that saved submission. It is deterministic and provider-free: no LLM request or private external transmission occurs.

The existing Overview loads its assessment list and selected detail normally. Mounting the explanation launcher adds no read. Explicit Explain or Reload performs one existing authorised assessment GET through the same generation-bound client. Topic changes use the resulting in-memory snapshot without another request. Clear removes that snapshot and cancels a pending explanation read. Leaving, selection changes, Overview refresh, disposal and access denial clear it as well. No transcript or saved browser storage is created.

The fresh raw GET response must match the selected assessment, accepted profile, revision and revision fingerprint. The existing `NoFriesNcscQuestionnaire.resultModel` checks the saved result's organisation, submission, answers, evaluator and calculation bindings. The new module never supplies replacement arithmetic. Drafts and rejected results have no explanation score. The existing mixed golden result remains **46.4%–60.7%**, with two unresolved answers including one pending N/A claim.

If a different revision or fingerprint arrives, the panel clears its output and requires **Refresh saved explanation**. That explicit GET binds to the newly observed version. Repeated changes require another explicit refresh. The panel does not reload or reset the questionnaire, call `openCyber`/`openAssessment`, replace Overview's saved detail, or adopt local unsaved answers. Editing and saving remain separate operations owned by the questionnaire.

After that explicit refresh, the explanation can describe a different saved version from the surrounding **Cyber baseline**. A persistent status notice says: “Cyber baseline and this explanation show different saved versions. Use the baseline’s Refresh control to reload it.” The baseline retains its previously loaded version. This also covers different fingerprints at the same revision number; the difference establishes no chronology. Topic changes and explanation reloads keep the notice whenever the displayed versions still differ. Clearing the explanation removes the notice with its detail. A host update or remount establishes the baseline version for comparison; reloading the baseline and then explaining its matching version shows no notice. The notice itself performs no read, navigation or draft change.

Each explanation block cites saved assessment ID, exact revision, revision fingerprint and consumed response/result field paths, or accepted metadata profile/version/catalogue fingerprint and field paths. These plain-text source references are not external evidence links and do not verify evidence. Prompts, pending N/A rationales, actions and citations are inserted with `textContent`; no arbitrary HTML or links are created. Starting actions come from accepted question guidance and follow accepted framework question order. They are suggestions, with no action, assignee or due date created.

Unknown includes pending N/A; the two counts are not added. N/A remains a claim rather than an approved exclusion. Evidence coverage is only the saved recorded coverage; the panel verifies no evidence or control effectiveness. It calculates no risk priority or trend and makes no certification/compliance claim.

The implementation is in `api/shared/protectedAssets/assessmentExplanation.js` and mounted by `organisationPicture.js`. The existing private bundle in `dashboardService.js` and static builder's integrity inputs includes it. The public Ask Fry/prospect client receives no assessment context, and no public assistant files are changed. There is no new route, provider, dependency, schema, grant, business mutation or conversation persistence. Existing server read security audits remain required; audit failure remains a failed read rather than explanation success.

The protected port was originally qualified against public composition `0f71a415` / tree `eb8fb6bb800f60a1f3b082831974002c4a756698` and merged through PR557. Earlier PR550 qualification on held PR536/18001fd remains historical. The protected port uses current read/draft interfaces and imports no submitted-answer writer or history module. The original submitted-update compatibility regression remains unchanged on frozen PR550/f1d31de.

Questionnaire, loader, backend and production options are outside this display-only change. Current admission and deployment status belongs in [the production dashboard entry point, #17](https://github.com/Discla1mer/NoFries/issues/17). A merged source change or local check does not establish deployment or customer acceptance; existing reader/writer/recovery and activation holds remain with their owners.

Local synthetic customer acceptance cases cover:

- No saved records: **Open Cyber Security** is available, with no assessment metrics.
- Saved draft: saved response progress is visible, with no score or **Explain this saved result** action.
- All Partial: **50.0%** implementation and no unresolved answers.
- All Unknown: **0.0%–100.0%** implementation range and **14 unresolved answers**.
- Mixed golden submission: **46.4%–60.7%**, with **2 unresolved answers including 1 pending N/A claim**.
- Malformed result: no inferred score or explanation score.
- Explicit revision or fingerprint drift: the first explanation GET detects the difference; the second, explicit **Refresh saved explanation** GET loads the result and notice. Topics add no reads; **Reload saved explanation** adds one GET. The baseline stays unchanged until its **Refresh** reloads the list and selected detail. Explaining that matching version clears the notice. Ordinary unsaved answers and rationales remain unchanged.

One existing local keyboard acceptance gap remains: at 390px, 320px and 568px with doubled root text, natural Tab to **Saved range** followed by Enter can leave the same focused control below the viewport after rerender. The identical six revision/fingerprint cases reproduce with both unchanged main and this candidate. This version-notice fix changes no focus behavior; full keyboard/mobile acceptance is not established.

These cases use local synthetic data. Hosted authentication, native SQL/RLS, deployed browser behavior, mobile assistive technology, native page zoom/pinch, OS keyboards and customer acceptance require separate qualification.
