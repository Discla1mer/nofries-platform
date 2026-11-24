# Product roadmap — source of truth

Part of #547. Edit the JSON below, then run `node scripts/generate-roadmap.js`.
`test/publicRoadmap.test.js` requires exact generated parity with `roadmap.html`.
The source controls the customer-facing lanes, introduction and lane meanings;
shared navigation and the existing legal limitation remain in the page shell.
Set `lastUpdated` to the date of the latest customer-facing source change; the
generator renders it as the page's “Last updated” line.

Planned work (In progress, Next and Later) is published in undated lanes with no
quarter, month or date. Only Done items carry a `period`, a plain month range of
the release that made them available.

## Evidence and interpretation

Snapshot: NZ FY27 Q2 (Oct–Dec 2026). At the paid-feature activation checkpoint, the verified
live release was `62a970280592b55fba08a8ffe8f041a034d61e21`, per the
[`62a9702` release receipt](https://github.com/Discla1mer/nofries-platform/issues/151#issuecomment-7077287283).
The [activation receipt](https://github.com/Discla1mer/nofries-platform/issues/151#issuecomment-7084596099)
records `NOFRIES_PAID_FRAMEWORKS_ENABLED=true` and
`NOFRIES_DEFER_STARTER_DETAILS=true` on production at `62a9702`, with live health
ok and the adviser status route answering 401 instead of 404. That receipt is the
release proof for the three Done items it activates:

- **Paid readiness self-assessments** (#501, #518, #528, #530, #538, #546):
  available, with access enabled by staff after a manual invoice. The public
  price and terms match the dashboard terms from #538 exactly. ISO 27001 stays a
  readiness self-assessment; certification comes only from an accredited
  certification body.
- **Paid assessment status for advisers** (#527, #555): status only for the
  client organisations an adviser is authorised to manage, without answers or
  results content. #555 was released in `12592b4` behind the same flag.
- **Simpler sign-up** (#531, #539): with deferred details on, new organisation
  setup asks for account type, organisation name and the authority confirmation
  only (`signupJourney.js` skips the name, role, address and NZBN fields; the
  server stores no contact details). The dashboard details gate returns
  `result_required` until the first result, then asks for name, role and
  business address before a board or insurer summary, a service request or a
  questionnaire copy. #424 (interrupted sign-up return) is still open and stays
  In progress.

The two earlier information items from `942ea19` are superseded: the
"Information about planned assessments" item is removed because the paid item
now describes the capability itself, and the fictional examples item no longer
says the assessments are unavailable. The fictional examples remain unlisted and
noindex. Scoring v2 (`NOFRIES_NCSC_PROFILE_V2`) stays off per the same receipt,
so "Updated NCSC questions" stays In progress.

The service note follows #543’s published responsibility distinction: working
through three improvements does not include hands-on implementation unless it is
separately agreed in scope. #543 merged as `35ff8729975c46af6f3d614ddd704b34982e59fc`
and is included in the current release. No agreement or signed-in service copy changes.

Release receipts and source PRs below are review evidence only. The generator
never emits these references into customer HTML. Keep the per-item source PR
mapping in the PR description as well as this source of truth.

Each item records source PRs. For planned work these are proposal/copy provenance,
not a claim that the feature ships. Lane placement is a proposed order for review,
not a date stated by those PRs, and planned lanes carry no dates. No earlier Done
periods are inferred from repository age. Done items have merged source PRs and a release
receipt whose deployed commit contains those changes. Availability remains bounded
by the description and the public feature-status registry.

| Done source PR | Verified merge commit | Release inclusion |
| --- | --- | --- |
| [#567](https://github.com/Discla1mer/nofries-platform/pull/567) | `d2b63739c47092192b0be0cf395e4cc2342c3a82` | [24 November release receipt](https://github.com/Discla1mer/nofries-platform/issues/151#issuecomment-7122999986): consultant landing fix for #561. |
| [#563](https://github.com/Discla1mer/nofries-platform/pull/563) | `8f7443f1302e89be1767f5b8a6df2f375e53f0ed` | [24 November release receipt](https://github.com/Discla1mer/nofries-platform/issues/151#issuecomment-7122999986): included in `64aed4c`; #564 adds tests only. |
| [#249](https://github.com/Discla1mer/nofries-platform/pull/249) | `82a4bf4df2f040a75102b949cd70bbc9b6f786fc` | Ancestor of `9977199`. |
| [#300](https://github.com/Discla1mer/nofries-platform/pull/300) | `70bad3bb4e742688e0f36f51fe5a20ec364fce0b` | Ancestor of `9977199`. |
| [#397](https://github.com/Discla1mer/nofries-platform/pull/397) | `dbe81b8dbc2649bb9c8bf8674e57a5d4dee9c286` | Ancestor of `9977199`. |
| [#254](https://github.com/Discla1mer/nofries-platform/pull/254) | `5cc761d959708a97285ec2f033804cd7ca6388fd` | Ancestor of `9977199`. |
| [#355](https://github.com/Discla1mer/nofries-platform/pull/355) | `448cb59d393b53116757d865c9db60be9e3d76fc` | Ancestor of `9977199`. |
| [#440](https://github.com/Discla1mer/nofries-platform/pull/440) | `4e16dc198c3abee63099cadf524db158f414ad66` | Ancestor of `9977199`. |
| [#408](https://github.com/Discla1mer/nofries-platform/pull/408) | `5d4c43716a249938caaa66079730f35210d70a46` | Ancestor of `9977199`. |
| [#261](https://github.com/Discla1mer/nofries-platform/pull/261) | `587cbc32a953a8df0ee80654e071f1b36f50950f` | Ancestor of `9977199`. |
| [#501](https://github.com/Discla1mer/nofries-platform/pull/501) | `942ea196c1bbfe8151ea0ad7971eff60cfee45ba` | Released in `942ea19`; ancestor of `9977199`. |
| [#529](https://github.com/Discla1mer/nofries-platform/pull/529) | `771cadf39267d2e2adb73e44068ae82bc97316a9` | Merged into the follow-on chain, included by #501's `942ea19` squash; the receipt explicitly confirms both fictional pages. |
| [#518](https://github.com/Discla1mer/nofries-platform/pull/518) | `164efaf6083b639058e9ac6ed65d8751bc9edf71` | Ancestor of `62a9702`; activated by the paid flag. |
| [#528](https://github.com/Discla1mer/nofries-platform/pull/528) | `5abb8588b38143d333abbd7728d1b466c9a4ffcd` | Ancestor of `62a9702`; activated by the paid flag. |
| [#530](https://github.com/Discla1mer/nofries-platform/pull/530) | `9741f16733477d94b3ccbd08fe5b7af2cfa55b02` | Ancestor of `62a9702`; activated by the paid flag. |
| [#538](https://github.com/Discla1mer/nofries-platform/pull/538) | `3d70f398f45204519bbd7f40b5e6854d387ffc52` | Ancestor of `62a9702`; activated by the paid flag. |
| [#546](https://github.com/Discla1mer/nofries-platform/pull/546) | `28b434f50305e9775efcb4b70eeba52d8ef5e5ab` | Released in `79239e9`; activated by the paid flag. |
| [#527](https://github.com/Discla1mer/nofries-platform/pull/527) | `ccb6db2f9328fd655aec982e2793c1a4e4fcbeeb` | Ancestor of `62a9702`; design and hold superseded by #555. |
| [#555](https://github.com/Discla1mer/nofries-platform/pull/555) | `12592b46d855cf9de072eb39ff73a1cc35a5fe1c` | Released in `12592b4`; activated by the paid flag. |
| [#531](https://github.com/Discla1mer/nofries-platform/pull/531) | `0227f0a6f50653076ec8fff3e3fa7cdd6f14425a` | Ancestor of `62a9702`; activated by the deferred-details flag. |
| [#539](https://github.com/Discla1mer/nofries-platform/pull/539) | `ac21ee80ac7e78bc01fb219978d6589ff61c1dda` | Released in `9977199`; activated by the deferred-details flag. |

The [942ea19 receipt](https://github.com/Discla1mer/nofries-platform/issues/500#issuecomment-7074327704)
remains the proof for the fictional examples item. The
[activation receipt](https://github.com/Discla1mer/nofries-platform/issues/151#issuecomment-7084596099)
is the proof for the paid, adviser status and sign-up items. The editorial
changelog records the same customer distinction separately from
release-engineering evidence.

## Published timeline data

```json
{
  "title": "What’s next.",
  "lastUpdated": "2026-11-25",
  "lead": "What you can use today, what is being built and what is planned.",
  "notice": "Planned work has no confirmed dates. Scope, order and availability may change, and planned work does not promise subscription inclusion.",
  "serviceNote": "Managed IT and 90-day managed security are separate services.",
  "lanes": {"Done": "Released and available for the accounts described.", "In progress": "Planned work being built or checked; not available yet.", "Next": "Planned work for the next planning window.", "Later": "Planned longer-term work; scope and order may change."},
  "items": [
    {"id": "free-dashboard", "lane": "Done", "period": "Oct–Dec 2026", "title": "Free NCSC dashboard", "text": "Create a Company account, save and resume the 14-question NCSC assessment, and compare submitted results over time. Free dashboard; it doesn’t expire. Existing agreed offers and their terms remain unchanged.", "prs": [249, 300], "release": "https://github.com/Discla1mer/nofries-platform/issues/151#issuecomment-7074953928"},
    {"id": "top-gaps", "lane": "Done", "period": "Oct–Dec 2026", "title": "Results with your top three gaps", "text": "See gaps in your saved answers, with reasons and next steps. Multi-factor authentication, patching, backups and payment-change checks come first. Copy or print a summary to share.", "prs": [249, 397], "release": "https://github.com/Discla1mer/nofries-platform/issues/151#issuecomment-7074953928", "link": {"href": "/sample-result.html", "label": "See a fictional result"}},
    {"id": "improvement-actions", "lane": "Done", "period": "Oct–Dec 2026", "title": "Improvement actions", "text": "Give assessment gaps an owner, due date and status. Carry those into the next assessment’s plan. A completed task does not prove that a control works.", "prs": [254, 355], "release": "https://github.com/Discla1mer/nofries-platform/issues/151#issuecomment-7074953928"},
    {"id": "demo", "lane": "Done", "period": "Oct–Dec 2026", "title": "Try the demo", "text": "Explore a fictional business before creating an account. Entries stay in your browser on this device until you choose Reset demo; they are not sent to No Fries.", "prs": [440], "release": "https://github.com/Discla1mer/nofries-platform/issues/151#issuecomment-7074953928", "link": {"href": "/try", "label": "Try the demo"}},
    {"id": "service-enquiries", "lane": "Done", "period": "Oct–Dec 2026", "title": "Ask about a service", "text": "Open the contact form from a service in the dashboard, with that service already named.", "prs": [408], "release": "https://github.com/Discla1mer/nofries-platform/issues/151#issuecomment-7074953928"},
    {"id": "emails", "lane": "Done", "period": "Oct–Dec 2026", "title": "Welcome and result emails", "text": "Receive a welcome email when you create an account and a link to your result when you submit an assessment.", "prs": [261], "release": "https://github.com/Discla1mer/nofries-platform/issues/151#issuecomment-7074953928"},
    {"id": "fictional-readiness-examples", "lane": "Done", "period": "Oct–Dec 2026", "title": "Fictional readiness examples", "text": "Two fictional readiness examples show what results for the paid assessments could look like. They use made-up information.", "prs": [501, 529], "release": "https://github.com/Discla1mer/nofries-platform/issues/500#issuecomment-7074327704"},
    {"id": "paid-assessments", "lane": "Done", "period": "Oct–Dec 2026", "title": "Paid readiness self-assessments", "text": "NIST CSF 2.0 and ISO 27001 readiness self-assessments are available as a paid add-on. The ISO 27001 readiness self-assessment is not certification. For accredited certification, use an accredited certification body.", "prs": [501, 518, 528, 530, 538, 546], "release": "https://github.com/Discla1mer/nofries-platform/issues/151#issuecomment-7084596099", "link": {"href": "/pricing.html#pricing-assessments", "label": "See pricing and how to get access"}},
    {"id": "adviser-paid-status", "lane": "Done", "period": "Oct–Dec 2026", "title": "Paid assessment status for advisers", "text": "Advisers can see paid assessment status for the client organisations they are authorised to manage. They see status only, not answers or results.", "prs": [527, 555], "release": "https://github.com/Discla1mer/nofries-platform/issues/151#issuecomment-7084596099"},
    {"id": "simpler-signin", "lane": "Done", "period": "Oct–Dec 2026", "title": "Simpler sign-up", "text": "Set up your organisation with its name and a confirmation that you are authorised to set it up. We ask for your name, role and business address after your first result, before you share a board or insurer summary or request a service.", "prs": [531, 539], "release": "https://github.com/Discla1mer/nofries-platform/issues/151#issuecomment-7084596099"},
    {"id": "consultant-dashboard", "lane": "Done", "period": "Oct–Dec 2026", "title": "Consultant dashboard after sign-in", "text": "Fixed an issue that could stop consultants opening their dashboard after signing in, while it was checking paid assessment status.", "prs": [567], "release": "https://github.com/Discla1mer/nofries-platform/issues/151#issuecomment-7122999986"},
    {"id": "dashboard-support-reference", "lane": "Done", "period": "Oct–Dec 2026", "title": "A reference for dashboard support", "text": "Some temporary problems loading your dashboard now show a support reference. If you see one, give it to No Fries when you ask for help.", "prs": [563], "release": "https://github.com/Discla1mer/nofries-platform/issues/151#issuecomment-7122999986"},
    {"id": "signup-return", "lane": "In progress", "title": "Returning to an unfinished sign-up", "text": "Planned guidance that brings an interrupted sign-up back to the same account. These changes are still being checked.", "prs": [424]},
    {"id": "weighted-assessment", "lane": "In progress", "title": "Updated NCSC questions", "text": "A planned 16-question assessment with weighted scoring. Existing submitted results keep their original scoring.", "prs": [440]},
    {"id": "contact-request", "lane": "In progress", "title": "Ask No Fries to contact you", "text": "A planned request button on results and Services that explains what staff will see before you choose it. Nothing is shared through this request unless you ask. This is separate from the existing link to the contact form.", "prs": [440, 454, 461]},
    {"id": "review-not-applicable", "lane": "Next", "title": "Review of not applicable answers", "text": "A planned way to review and confirm answers marked not applicable. For now, these answers count as not yet met and stay in your result; no review changes that.", "prs": [440, 480]},
    {"id": "update-answers", "lane": "Next", "title": "Update submitted answers", "text": "Planned ways to update submitted answers and refresh the result without starting again.", "prs": [249, 440]},
    {"id": "evidence-reports", "lane": "Next", "title": "Evidence and board reporting", "text": "Planned evidence references, owners, recurring reviews and downloadable assessment reports. Customer uploads and a report you can download yourself are not available yet. A reference or completed review does not independently verify a control.", "prs": [440, 478]},
    {"id": "client-requirements", "lane": "Next", "title": "Assess against your own requirements", "text": "Planned question review alongside the source requirements, with customer-specific results kept separate from NCSC results. Text import is being developed; PDF, DOCX and scanned-document imports are later options.", "prs": [3, 440]},
    {"id": "reminders", "lane": "Next", "title": "Email reminders", "text": "Planned unfinished-assessment nudges, reassessment reminders and monthly status emails. Settings and unsubscribe links exist; reminders still need testing and activation.", "prs": [261, 440]},
    {"id": "assessment-types", "lane": "Later", "title": "Separate assessment types", "text": "Planned CIS, Essential Eight and distinct ASD Essentials assessments, plus a view of how answers map to SMB1001. Each assessment would keep its own version, scope and results; a mapping is not certification.", "prs": [3, 440]},
    {"id": "connected-evidence", "lane": "Later", "title": "Connected evidence and continuous checks", "text": "Planned connections to supported systems, with scope, freshness and missing data visible. Potential sources include Microsoft 365, Datto RMM and managed detection and response. These are not active integrations or included services.", "prs": [3, 440]},
    {"id": "controls-reviews", "lane": "Later", "title": "Controls, evidence and review workflows", "text": "Planned reusable controls, traceable evidence, risk exceptions, policies and approvals. Longer-term work covers assets, access, suppliers, people, recovery and technical reviews. Claims, technical checks and independent assurance would remain distinct.", "prs": [3, 440]},
    {"id": "questionnaires-privacy", "lane": "Later", "title": "Questionnaires and privacy responsibilities", "text": "Planned reuse of reviewed answers for customer questionnaires and preparation for independent SOC 2 assessment. Track data handling, retention and deletion responsibilities. Legal decisions stay separate from technical evidence; No Fries does not issue an independent assurance opinion.", "prs": [3, 440]},
    {"id": "consultant-services", "lane": "Later", "title": "Client and service overview", "text": "Planned status views for agreed No Fries services across the client organisations a consultant is authorised to manage.", "prs": [440, 527]},
    {"id": "ai-governance", "lane": "Later", "title": "AI governance and IT optimisation", "text": "Planned ways to understand AI use and identify opportunities to improve IT.", "prs": [3, 440]}
  ]
}
```

Public page inventory and conflict decisions: [Stream H review](review/stream-h/inventory.md).
