# Stream H public-page inventory

Refreshed in FY27 Q2 against main and live
`99771994a1d94e6e777ae8673a6da90a8aec799e`, confirmed by the
[official release receipt](https://github.com/Discla1mer/nofries-platform/issues/151#issuecomment-7074953928)
and the public health and release identities.
The source list is `lib/publicAssets.js`, plus generated entry points and redirects.
“No change” means verified for this availability/roadmap task, not a claim that every
future copy improvement is complete. Source and release reconciliation is in
[the roadmap source](../../roadmap.md).

| Page or surface | Decision and evidence |
| --- | --- |
| `roadmap.html` | Change in the shared roadmap PR: generated quarters and lanes; source PRs and release proof stay in docs/PR evidence only. Keep incoming `#roadmap-planned` and legal limitation. |
| `index.html` — home and how it works | Verified no change: 14-question NCSC check, saved progress, free non-expiring access, illustrative result and separately priced service. How-it-works CTA was removed in #372; no standalone how page exists. |
| FAQ | Verified no standalone FAQ page, FAQ section or routed FAQ entry in the public source; no page created. |
| About (`/about.html`, `/About.html`) | Verified no-change redirects to `/` in server and SWA config; no separate About copy. |
| `pricing.html` — plans/frameworks | Existing page-group draft #549: name both planned paid assessments directly and link their roadmap entry without publishing a price. Preserve #543's now-live managed-security scope lines. |
| `managed-it.html` — services | Verified no change: services are separately scoped and priced; its dashboard paragraph already marks automatic updates and connected feeds planned. No new free-dashboard entitlement is promised. |
| `scope.html` | Verified no change: access-checked service guide shell; expressly service information, not a signed agreement. |
| `insurance.html` | Verified no change for Stream H: free check, top gaps and separate paid summary. #490/#493 own campaign journey and sample-link changes. #541 remains held outside Stream H; no setup referrer changes here. |
| `supplier-questionnaire.html` | Verified no change for Stream H: self-reported answers and separate service; #490/#493 own planned campaign edits. |
| `board.html` | Verified no change for Stream H: current summary and separate paid written summary; #490/#493 own planned campaign edits. |
| `invoice-scams.html` | Verified no change for Stream H: payment checks and free NCSC entry; #490/#493 own campaign edits. |
| `sample-result.html` | Verified no change: explicitly fictional NCSC result, copy/print-level example; #493 owns its extra examples. |
| `fictional-iso-example.html`, `fictional-nist-example.html` | Verified no change: released in 942ea19, unlisted/noindex, clearly fictional. No public navigation or roadmap links added. Their release does not enable paid assessments. |
| `contact.html` | Verified no change: enquiry availability and response wording do not advertise paid assessment availability. |
| `account-help.html`, `login.html` | Verified no change: account recovery/sign-in guidance, no roadmap claims; #424 owns recovery flow changes. |
| `report.html` | Verified no change: issue-report form, not an assessment report or download promise. |
| `privacy.html` | References reviewed only; no change. Existing data, enabled-feature and service-email notices are not availability announcements. Preserve meaning and retention statements. |
| `terms.html`, `pilot-terms.html` | References reviewed only; no change. Roadmap/previews add no services to agreements; existing scope and assessment limitations retained. |
| `404.html`, `error.html` | Verified no change: navigation and recovery, no feature availability claims. |
| `/try` (`demo/try/document.js`) | Verified no change: fictional, browser-local demo and reset explanation. |
| Generated `/signup`, `/dashboard`, signed-in and staff shells | No public marketing rewrite. Their auth/session and paid rendering stay with existing owners; no protected assets changed. |
| Shared nav/footer | Verified no change: shared Home/Pricing/Managed IT/Roadmap/Contact links already point to the roadmap; footer preserves Privacy/Terms. Existing tests cover the public shell. |
| Site version / `lib/frontendReleaseInfo.js` | Verified no change: generated release identity, not an editorial feature list. Do not hand-edit release identity. |
| `sites/news/README.md`, retired News | Verified no change: retired separate site, excluded from dashboard build. No current release-notes page to refresh. |
| `sitemap.xml`, `robots.txt` | Verified no change: roadmap already discoverable; fictional paid examples remain unlisted. |

## Concurrent work and reconciliation

- #543 merged as `35ff872` while this work was in progress. Its managed-security
  scope wording is now live and retained. Pricing draft #549 starts from `ac21ee8`, including
  #543 and #539; only the separate planned-assessment paragraph changes.
- #546 merged as `28b434f50305e9775efcb4b70eeba52d8ef5e5ab` and is in the
  current live `9977199`. No duplicate activation-readiness work is needed here.
- #501/#518/#528/#529/#530/#538 are merged; their gated runtime remains off.
  Public price absence is intentional. Activation-copy alignment belongs to #500.
- #539 is included in live `9977199`, but its feature remains off, so the
  roadmap retains planned status. #544/#545 are released test-only changes.
  #541 remains held outside Stream H. Open #477/#484/#490/#493 own campaign
  and authenticated result work; no edits to those page groups or runtime files here.
- Main and live now match; no additional page group has a confirmed status
  mismatch requiring another draft. Home/how/FAQ/about, services, campaigns,
  examples, navigation/footer, release information and legal references retain
  their verified no-change decisions above.
- Older roadmap proposals are retained as grouped planned themes. Removing
  “audit-ready” marketing language does not change the existing legal limitation.

## Verification and review

Run generated parity, feature-status, public navigation/legal/copy checks, the
static build and `scripts/accessibility/roadmap.cjs` for keyboard skip/jumps,
feature links, 375px stacking and desktop columns. Source PRs and receipt links
must not enter customer HTML. All 21 items remain present; Done items retain
merged source and release proof here, and the PR description lists every item.
The established public accessibility suite also exercises the built roadmap at
320px/1280px and doubled text.

The previous independent review required separate N/A-review and scoring work,
and retention of the planned contact-request workflow. Those corrections remain.
A fresh scoped review of this release-evidence refresh and removal of customer
engineering links is required before signoff. Current checks and independent
review results are recorded in the draft PR, bound to its exact head.
