# Stream H public-page checklist

Snapshot: current main and live `99771994a1d94e6e777ae8673a6da90a8aec799e`.
The [official receipt](https://github.com/Discla1mer/nofries-platform/issues/151#issuecomment-7074953928)
and public health/release identities agree. This supersedes `942ea19` as live;
its customer-visible information remains recorded in [the roadmap source](../../roadmap.md).

The checklist below is reproduced directly in #548's PR description so it can be
reviewed there. All 21 registered HTML sources are covered: `/index.html` redirects
301 to Home; the other 20 return 200. Live GETs also confirm the redirects and 404s
listed below. Content checks use the released main source, public responses and
availability tests. Legal pages were reviewed only for references and meaning.
“No change needed” is scoped to this availability/roadmap task.

| Page URL / surface | Precisely what was checked | Decision |
| --- | --- | --- |
| Home — [/](https://nofries.nz/) | Live page; `index.html`: 14-question NCSC check, free non-expiring access, save/resume and illustrative result; no paid assessment availability claim. One editorial changelog link is the only new Home change. | #550 (changelog link); availability copy: no change needed. |
| [/index.html](https://nofries.nz/index.html) | 301 redirect to `/`; not a separate Home page. | No change needed. |
| How it works — [/#dashboard-benefits](https://nofries.nz/#dashboard-benefits) | Live Home section: assess, understand and move forward; service help remains separate from the free check. | No change needed. |
| [/how-it-works](https://nofries.nz/how-it-works), [/how-it-works.html](https://nofries.nz/how-it-works.html) | Both return 404; no standalone route/file. Home contains the explanation above. | No change needed; do not invent a page. |
| [/faq](https://nofries.nz/faq), [/faq.html](https://nofries.nz/faq.html) | Both return 404; no public FAQ file, routed FAQ or FAQ section in the source. | No change needed; do not invent a page. |
| [/about.html](https://nofries.nz/about.html) | 302 redirect to `/`, confirmed in live response, server and static route configuration. | No change needed. |
| [/About.html](https://nofries.nz/About.html) | 302 redirect to `/`; case-sensitive legacy alias, not separate About copy. | No change needed. |
| [/roadmap.html](https://nofries.nz/roadmap.html) | `roadmap.html`: NZ quarters, Done/planned distinction, release proof, no paid price, legal limitation and incoming `#roadmap-planned` anchor. Include the two published 942ea19 information items. | #548. |
| [/pricing.html](https://nofries.nz/pricing.html) | `pricing.html`: paid options explicitly planned, no paid-assessment price, and now-live #543 responsibility wording preserved; existing service prices/terms unchanged. | #549. |
| Frameworks — [/pricing.html#pricing-future-assessments](https://nofries.nz/pricing.html#pricing-future-assessments) | Existing section is the public framework-options surface; name planned NIST CSF 2.0 and ISO 27001 readiness and link the roadmap, without implying activation. | #549; no separate frameworks page needed. |
| [/managed-it.html](https://nofries.nz/managed-it.html) | `managed-it.html`: separate scoped service tiers; automatic dashboard updates and connected feeds already labelled planned; no new free entitlement. | No change needed. |
| [/scope.html](https://nofries.nz/scope.html) | `scope.html`: access-checked service-guide shell, explicitly information rather than a signed agreement; no paid-assessment availability claim. | No change needed. |
| [/insurance.html](https://nofries.nz/insurance.html) | `insurance.html`: free NCSC check/top gaps and separate paid service summary. Preserve campaign ownership in #490/#493; #541 remains outside H. | No change needed for H. |
| [/supplier-questionnaire.html](https://nofries.nz/supplier-questionnaire.html) | `supplier-questionnaire.html`: self-reported answers and separate service; no claim of enabled paid frameworks. Preserve #490/#493 campaign work. | No change needed for H. |
| [/board.html](https://nofries.nz/board.html) | `board.html`: current summary versus separate paid written summary; no self-service downloadable assessment-report promise. Preserve #490/#493. | No change needed for H. |
| [/invoice-scams.html](https://nofries.nz/invoice-scams.html) | `invoice-scams.html`: payment checks/free NCSC entry and separately scoped help. Preserve #490/#493 campaign edits. | No change needed for H. |
| [/sample-result.html](https://nofries.nz/sample-result.html) | `sample-result.html`: fictional NCSC result, copy/print example and no paid availability claim; #493 owns further examples. | No change needed for H. |
| [/fictional-iso-example.html](https://nofries.nz/fictional-iso-example.html) | `fictional-iso-example.html`: 200, fictional content, noindex and unlisted; included in 942ea19 through #501. Publication does not enable paid assessment access. | No page change needed; publication recorded in #548/#550. |
| [/fictional-nist-example.html](https://nofries.nz/fictional-nist-example.html) | `fictional-nist-example.html`: 200, fictional content, noindex and unlisted; #529 included by #501 in 942ea19. No new public links to the preview. | No page change needed; publication recorded in #548/#550. |
| [/contact.html](https://nofries.nz/contact.html) | `contact.html`: enquiry availability/response wording; does not announce paid assessment availability. No form submitted. | No change needed. |
| [/account-help.html](https://nofries.nz/account-help.html) | `account-help.html`: recovery/sign-in guidance, no roadmap promise; #424 retains recovery-flow ownership. | No change needed. |
| [/login.html](https://nofries.nz/login.html) | `login.html`: account-entry copy and no enabled paid-framework claim. No sign-in attempted. | No change needed. |
| [/report.html](https://nofries.nz/report.html) | `report.html`: issue-report form, not an assessment report/download offering. No form submitted. | No change needed. |
| [/privacy.html](https://nofries.nz/privacy.html) | `privacy.html`: references only—data, enabled-feature and service-email notices are not availability announcements; retention meaning preserved. | No change needed. |
| [/terms.html](https://nofries.nz/terms.html) | `terms.html`: references only—assessment limitations and agreed scope retained; roadmap adds no services or promises. | No change needed. |
| [/pilot-terms.html](https://nofries.nz/pilot-terms.html) | `pilot-terms.html`: references only—existing offer, service scope and limitations retained. | No change needed. |
| [/404.html](https://nofries.nz/404.html) | `404.html`: directly served recovery page; navigation offers no unavailable features. Unknown routes still return 404. | No change needed. |
| [/error.html](https://nofries.nz/error.html) | `error.html`: recovery/navigation copy, no feature availability claims. | No change needed. |
| [/try](https://nofries.nz/try) | Live generated demo: fictional business, browser-local data and reset explanation; no paid framework promise. | No change needed. |
| [/signup](https://nofries.nz/signup), [/dashboard](https://nofries.nz/dashboard) | Generated entry shells inspected in source only; no protected customer data accessed. Session/availability behavior remains with existing owners. | No change needed. |
| Shared navigation/footer — [Home](https://nofries.nz/), [Roadmap](https://nofries.nz/roadmap.html) | Across registered pages: Home/Pricing/Managed IT/Roadmap/Contact and login links, current-page markings, Privacy/Terms; no link to retired News or fictional paid examples. | No change needed; #550 uses the same navigation. |
| Site version — [/roadmap.html#site-version](https://nofries.nz/roadmap.html#site-version) | Generated version disclosure is release identity, not an editorial changelog. Health/release identities match 9977199; no hand-edit of version data. | No change needed. |
| Changelog — [/changelog.html](https://nofries.nz/changelog.html) | Currently 404; no current public editorial changelog or release-notes page. Add evidence-grounded published information versus planned functionality, with quarter precision. | #550 (new page, editorial source and Home link). |
| Retired News — [news.nofries.nz](https://news.nofries.nz/) | `sites/news/README.md` records retirement; source mirror is excluded from the dashboard build and no longer linked. It is not the current changelog and is not resurrected. | No change needed. |
| [/sitemap.xml](https://nofries.nz/sitemap.xml) | Roadmap already discoverable; fictional paid examples absent. Add only the new changelog URL. | #550. |
| [/robots.txt](https://nofries.nz/robots.txt) | Existing crawler rules; fictional examples retain their own noindex declarations and remain absent from the sitemap. | No change needed. |

## Concurrent work and release interpretation

- #548 owns the roadmap; #549 owns the planned-assessment pricing paragraph.
  #550 is the only additional group warranted by the follow-up: an editorial
  changelog, its own assets and a single Home link. Its source files do not overlap
  either existing draft. No other existing page has a confirmed status mismatch.
- #543's managed-security responsibility clarification is live and retained.
  #539 is included in 9977199 but deferred details remains off, so it stays planned.
  #544/#545 are test-only. #541 remains held outside Stream H.
- The [942ea19 receipt](https://github.com/Discla1mer/nofries-platform/issues/500#issuecomment-7074327704)
  confirms two published information changes: planned-assessment positioning and
  the fictional ISO/NIST examples. #501 and #529 are their source PRs. Locked cards,
  saved paid answers/results/progress, enquiry choices and prices from the same
  release do not become available while the paid flag is off. The
  [latest paid-availability receipt](https://github.com/Discla1mer/nofries-platform/issues/500#issuecomment-7074639277)
  still records it unset. Keep all paid capability work planned and prices unpublished.
- Open #424/#477/#484/#490/#493 keep their account/campaign/result scopes. No legal,
  runtime, flag, authorisation or production changes are part of H.
- #548 already includes current main. #549 was refreshed by an ordinary merge
  from main; the follow-up uses ordinary pushes, without rewriting branch history.

## Verification and review

Check generated parity, source links, customer copy guardrails, incoming roadmap
fragments, 375px stacking/keyboard navigation and desktop columns. The roadmap now
has 23 items: eight Done (including two published information items) and 15 planned.
Technical receipts and source PRs stay in docs/PR evidence, never customer HTML.
The changelog independently checks generation, links, planned labels and absence
of engineering details/prices. Its homepage link and new page use the existing
public shell. The public accessibility suite includes narrow screens and doubled
text. Preserve the prior N/A and contact-request availability distinctions.

Record fresh independent copy review of all three drafts, this checklist and the
PR descriptions, together with final-head hosted CI, in the descriptions.
