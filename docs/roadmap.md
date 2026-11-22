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

Snapshot: NZ FY27 Q2 (Oct–Dec 2026). Current main and production both identify
`99771994a1d94e6e777ae8673a6da90a8aec799e`.
The [official release receipt](https://github.com/Discla1mer/nofries-platform/issues/151#issuecomment-7074953928)
records this release; the public health and release endpoints agree.
It includes #543's managed-security responsibility clarification, #539's
sign-up fixes, and the test-only changes in #544/#545. #539 remains planned
for customers because the receipt confirms deferred details is still off.
#541 remains held outside Stream H; no campaign or setup changes are included.

The paid assessment availability recorded in the
[earlier receipt](https://github.com/Discla1mer/nofries-platform/issues/500#issuecomment-7074639277)
remains unchanged: `NOFRIES_PAID_FRAMEWORKS_ENABLED` is unset. #501, #518,
#528, #529, #530, #538 and #546 are merged and included in this release, but
paid assessments remain planned, not Done customer capabilities. No paid
assessment prices are published. The customer-visible changes from `942ea19` were the planned-assessment information
and two fictional readiness examples. These published information items are Done
in Oct–Dec 2026; the paid capability stays planned. The fictional examples remain
unlisted and noindex. The last explicit NCSC-v2 flag receipt records it unset:
[prior release evidence](https://github.com/Discla1mer/nofries-platform/issues/500#issuecomment-7072631196).
No later activation evidence was found. Do not infer activation from a merged PR.

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

The [942ea19 receipt](https://github.com/Discla1mer/nofries-platform/issues/500#issuecomment-7074327704)
is proof for the two published information items below. `9977199` supersedes it
as the live release. #518/#528/#530/#538 remain provenance for planned paid work,
not evidence of customer availability. The editorial changelog records the same
customer distinction separately from release-engineering evidence.

## Published timeline data

```json
{
  "title": "What’s next.",
  "lastUpdated": "2026-11-22",
  "lead": "What you can use today, what is being built and what is planned.",
  "notice": "Planned work has no confirmed dates. Scope, order and availability may change, and planned work does not promise subscription inclusion.",
  "serviceNote": "90-day managed security includes a written summary you can give your board or insurer now. That summary is part of the paid service. We work through three improvements with you. For each improvement, the agreed scope needs to say whether No Fries, you or your IT provider makes the change. Hands-on changes by No Fries need to be separately agreed in that scope. Managed IT is the separate day-to-day service.",
  "lanes": {"Done": "Released and available for the accounts described.", "In progress": "Planned work being built or checked; not available yet.", "Next": "Planned work for the next planning window.", "Later": "Planned longer-term work; scope and order may change."},
  "items": [
    {"id": "free-dashboard", "lane": "Done", "period": "Oct–Dec 2026", "title": "Free NCSC dashboard", "text": "Create a Company account, save and resume the 14-question NCSC assessment, and compare submitted results over time. Free dashboard; it doesn’t expire. Existing agreed offers and their terms remain unchanged.", "prs": [249, 300], "release": "https://github.com/Discla1mer/nofries-platform/issues/151#issuecomment-7074953928"},
    {"id": "top-gaps", "lane": "Done", "period": "Oct–Dec 2026", "title": "Results with your top three gaps", "text": "See gaps in your saved answers, with reasons and next steps. Multi-factor authentication, patching, backups and payment-change checks come first. Copy or print a summary to share.", "prs": [249, 397], "release": "https://github.com/Discla1mer/nofries-platform/issues/151#issuecomment-7074953928", "link": {"href": "/sample-result.html", "label": "See a fictional result"}},
    {"id": "improvement-actions", "lane": "Done", "period": "Oct–Dec 2026", "title": "Improvement actions", "text": "Give assessment gaps an owner, due date and status. Carry those into the next assessment’s plan. A completed task does not prove that a control works.", "prs": [254, 355], "release": "https://github.com/Discla1mer/nofries-platform/issues/151#issuecomment-7074953928"},
    {"id": "demo", "lane": "Done", "period": "Oct–Dec 2026", "title": "Try the demo", "text": "Explore a fictional business before creating an account. Entries stay in your browser on this device until you choose Reset demo; they are not sent to No Fries.", "prs": [440], "release": "https://github.com/Discla1mer/nofries-platform/issues/151#issuecomment-7074953928", "link": {"href": "/try", "label": "Try the demo"}},
    {"id": "service-enquiries", "lane": "Done", "period": "Oct–Dec 2026", "title": "Ask about a service", "text": "Open the contact form from a service in the dashboard, with that service already named.", "prs": [408], "release": "https://github.com/Discla1mer/nofries-platform/issues/151#issuecomment-7074953928"},
    {"id": "emails", "lane": "Done", "period": "Oct–Dec 2026", "title": "Welcome and result emails", "text": "Receive a welcome email when you create an account and a link to your result when you submit an assessment.", "prs": [261], "release": "https://github.com/Discla1mer/nofries-platform/issues/151#issuecomment-7074953928"},
    {"id": "planned-assessment-information", "lane": "Done", "period": "Oct–Dec 2026", "title": "Information about planned assessments", "text": "The pricing page and roadmap distinguish planned paid assessments from options available today. Paid assessments are not available yet and their prices are not published.", "prs": [501], "release": "https://github.com/Discla1mer/nofries-platform/issues/500#issuecomment-7074327704"},
    {"id": "fictional-readiness-examples", "lane": "Done", "period": "Oct–Dec 2026", "title": "Fictional readiness examples", "text": "Two fictional readiness examples show what results for the planned assessments could look like. They use made-up information. The assessments themselves are not available yet.", "prs": [501, 529], "release": "https://github.com/Discla1mer/nofries-platform/issues/500#issuecomment-7074327704"},
    {"id": "simpler-signin", "lane": "In progress", "title": "Simpler sign-up and return visits", "text": "Planned improvements to account setup and returning to saved work, including organisations with several members. These changes are still being checked.", "prs": [424, 539]},
    {"id": "paid-assessments", "lane": "In progress", "title": "Planned paid assessments", "text": "Paid NIST CSF 2.0 and ISO 27001 readiness self-assessments are planned and are not available yet. Work includes separate saved answers, readiness results and assessment progress. Prices will be published when these options become available.", "prs": [501, 518, 528, 529, 530, 538, 546]},
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
    {"id": "consultant-services", "lane": "Later", "title": "Client and service overview", "text": "Planned status views for agreed No Fries services and client organisations a consultant is authorised to manage. Consultants will see paid assessment status for the client organisations they are authorised to manage.", "prs": [440, 527]},
    {"id": "ai-governance", "lane": "Later", "title": "AI governance and IT optimisation", "text": "Planned ways to understand AI use and identify opportunities to improve IT.", "prs": [3, 440]}
  ]
}
```

Public page inventory and conflict decisions: [Stream H review](review/stream-h/inventory.md).
