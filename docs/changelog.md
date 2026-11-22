# Product changelog — editorial source

Part of #547. This is the editorial source for `changelog.html`, generated with
`node scripts/generate-changelog.js` and checked by strict parity tests.
It records customer-relevant information, not an exhaustive engineering log.
Published entries carry a plain month-range `period` label (a paragraph, not a
heading). Planned entries carry no dates.
The separate News site remains retired; this page does not revive it.

## Review evidence (not rendered)

Integration main is `c443f9177172685cd3154c2dc77276138260d1a2`. Independently
verified live is now the same commit, supported by the
[new official receipt](https://github.com/Discla1mer/nofries-platform/issues/151#issuecomment-7076315188)
and matching public identities. This receipt arrived during the refresh, replacing
previously verified live `9977199`, which had superseded `942ea19`. A main merge
alone did not establish the live state. #541 and test-only #551 are now separately
release-verified; they do not change the existing editorial availability claims.
The [942ea19 receipt](https://github.com/Discla1mer/nofries-platform/issues/500#issuecomment-7074327704)
confirms the planned-assessment copy and both fictional examples were published.
#501 was the squash release of the reviewed follow-on chain, including #529.

The [latest paid-availability receipt](https://github.com/Discla1mer/nofries-platform/issues/500#issuecomment-7074639277)
still records the paid flag unset; the [9977199 receipt](https://github.com/Discla1mer/nofries-platform/issues/151#issuecomment-7074953928)
records deferred details off, with no later activation evidence. A merged or deployed change behind a disabled flag is not available.
No flag, permission, account or operational details belong in customer copy.
#546, #544 and #545 do not establish new customer availability and have no
separate editorial entry. No releases in earlier periods are inferred.

| Editorial entry | Source PRs | Release evidence and interpretation |
| --- | --- | --- |
| Information about planned assessments | #501 | `942ea19`: published positioning only. |
| Fictional readiness examples | #501, #529 | `942ea19`: the two standalone examples are published, fictional and noindex; keep them unlisted. |
| Clearer managed-security responsibilities | #543 | `9977199`: published service-scope clarification; existing terms remain. |
| Paid readiness self-assessments | #501, #518, #528, #529, #530, #538, #546 | Included in released code, but still planned and unavailable. No price published. |
| Simpler account setup | #539 | Included in `9977199`, but still planned and unavailable. |

## Customer content

```json
{
  "title": "What’s changed.",
  "lead": "Published product information and changes, with planned work labelled separately.",
  "period": "Oct–Dec 2026",
  "notice": "Publishing information or an example does not make a planned assessment available. Planned work has no promised delivery date or subscription inclusion.",
  "published": [
    {"id": "planned-assessment-information", "title": "Information about planned assessments", "text": "The pricing page and roadmap now distinguish planned paid NIST CSF 2.0 and ISO 27001 readiness self-assessments from options available today. The paid assessments are not available yet, and their prices are not published.", "prs": [501], "release": "942ea196c1bbfe8151ea0ad7971eff60cfee45ba"},
    {"id": "fictional-readiness-examples", "title": "Fictional readiness examples", "text": "Two fictional examples illustrate possible NIST CSF 2.0 and ISO 27001 readiness results using made-up information. These examples do not provide access to the planned paid assessments.", "prs": [501, 529], "release": "942ea196c1bbfe8151ea0ad7971eff60cfee45ba"},
    {"id": "service-responsibilities", "title": "Clearer managed-security responsibilities", "text": "The pricing page now explains that, for each improvement, the agreed scope says whether No Fries, you or your IT provider makes the change, and that hands-on changes by No Fries must be agreed separately. The clarification preserves the agreed service scope and existing terms.", "prs": [543], "release": "99771994a1d94e6e777ae8673a6da90a8aec799e", "link": {"href": "/pricing.html#pricing-pilot", "label": "Read the service details"}}
  ],
  "planned": [
    {"id": "paid-assessments", "title": "Paid readiness self-assessments", "text": "Paid NIST CSF 2.0 and ISO 27001 readiness self-assessments are planned and are not available yet. Work includes saved answers, readiness results and assessment progress. Prices will be published when these options become available.", "prs": [501, 518, 528, 529, 530, 538, 546], "link": {"href": "/roadmap.html#roadmap-planned", "label": "See the planned assessments"}},
    {"id": "account-setup", "title": "Simpler account setup", "text": "Improvements to account setup for organisations with several members are planned and are not available yet.", "prs": [539]}
  ]
}
```
