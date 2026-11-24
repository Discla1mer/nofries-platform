# Product changelog — editorial source

Part of #547. This is the editorial source for `changelog.html`, generated with
`node scripts/generate-changelog.js` and checked by strict parity tests.
It records customer-relevant information, not an exhaustive engineering log.
Published entries carry a plain month-range `period` label (a paragraph, not a
heading). Planned entries carry no dates.
The separate News site remains retired; this page does not revive it.

## Review evidence (not rendered)

Integration main and independently verified live are both
`62a970280592b55fba08a8ffe8f041a034d61e21`, per the
[`62a9702` release receipt](https://github.com/Discla1mer/nofries-platform/issues/151#issuecomment-7077287283).
The [activation receipt](https://github.com/Discla1mer/nofries-platform/issues/151#issuecomment-7084596099)
records the paid-frameworks and deferred-details flags set on production at
`62a9702`. That receipt is the evidence for the three new published entries
below. A merged change behind a disabled flag is not available; these entries
rely on the activation, not on the merges alone.
The [942ea19 receipt](https://github.com/Discla1mer/nofries-platform/issues/500#issuecomment-7074327704)
confirms both fictional examples were published. #501 was the squash release of
the reviewed follow-on chain, including #529.
No flag, permission, account or operational details belong in customer copy.
No releases in earlier periods are inferred.

The earlier "Information about planned assessments" entry is removed: the paid
entry now describes the capability, its price and access. Both planned entries
are now published, so the planned section is empty and not rendered. #424
(returning to an unfinished sign-up) is still open and stays on the roadmap only.

| Editorial entry | Source PRs | Release evidence and interpretation |
| --- | --- | --- |
| Fictional readiness examples | #501, #529 | `942ea19`: the two standalone examples are published, fictional and noindex; keep them unlisted. |
| Clearer managed-security responsibilities | #543 | `9977199`: published service-scope clarification; existing terms remain. |
| NIST CSF 2.0 and ISO 27001 readiness self-assessments | #501, #518, #528, #530, #538, #546 | Activated on `62a9702`. Price and terms match the #538 dashboard terms exactly. |
| Paid assessment status for advisers | #527, #555 | Released in `12592b4`; activated on `62a9702`. Status only. |
| Simpler sign-up | #531, #539 | Activated on `62a9702`. Business details are asked for after the first result. |

## Customer content

```json
{
  "title": "What’s changed.",
  "lead": "Published product information and changes. Planned work is on the roadmap.",
  "period": "Oct–Dec 2026",
  "notice": "Planned work has no promised delivery date or subscription inclusion.",
  "published": [
    {"id": "fictional-readiness-examples", "title": "Fictional readiness examples", "text": "Two fictional examples illustrate possible NIST CSF 2.0 and ISO 27001 readiness results using made-up information. These examples do not provide access to the paid assessments.", "prs": [501, 529], "release": "942ea196c1bbfe8151ea0ad7971eff60cfee45ba"},
    {"id": "service-responsibilities", "title": "Clearer managed-security responsibilities", "text": "The pricing page now explains that, for each improvement, the agreed scope says whether No Fries, you or your IT provider makes the change, and that hands-on changes by No Fries must be agreed separately. The clarification preserves the agreed service scope and existing terms.", "prs": [543], "release": "99771994a1d94e6e777ae8673a6da90a8aec799e", "link": {"href": "/pricing.html#pricing-pilot", "label": "Read the service details"}},
    {"id": "paid-assessments", "title": "NIST CSF 2.0 and ISO 27001 readiness self-assessments", "text": "Paid NIST CSF 2.0 and ISO 27001 readiness self-assessments are now available. The ISO 27001 readiness self-assessment is not certification. For accredited certification, use an accredited certification body.", "prs": [501, 518, 528, 530, 538, 546], "release": "https://github.com/Discla1mer/nofries-platform/issues/151#issuecomment-7084596099", "link": {"href": "/pricing.html#pricing-assessments", "label": "See pricing and how to get access"}},
    {"id": "adviser-paid-status", "title": "Paid assessment status for advisers", "text": "Advisers can see paid assessment status for the client organisations they are authorised to manage. They see status only, not answers or results.", "prs": [527, 555], "release": "https://github.com/Discla1mer/nofries-platform/issues/151#issuecomment-7084596099"},
    {"id": "simpler-sign-up", "title": "Simpler sign-up", "text": "Setting up your organisation now asks for its name and a confirmation that you are authorised to set it up. We ask for your name, role and business address after your first result, before you share a board or insurer summary or request a service.", "prs": [531, 539], "release": "https://github.com/Discla1mer/nofries-platform/issues/151#issuecomment-7084596099"}
  ],
  "planned": []
}
```
