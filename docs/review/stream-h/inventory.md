# Stream H public-page inventory

Inspected against main `79239e9de2a73b449c9ef05d2d56d567bf7f19df` in FY27 Q2.
The source list is `lib/publicAssets.js`, plus generated entry points and redirects.
“No change” means verified for this availability/roadmap task, not a claim that every
future copy improvement is complete. Source and release reconciliation is in
[the roadmap source](../../roadmap.md).

| Page or surface | Decision and evidence |
| --- | --- |
| `roadmap.html` | Change in the shared roadmap PR: generated quarters, lanes, sources and release proof. Keep incoming `#roadmap-planned` and legal limitation. |
| `index.html` — home and how it works | Verified no change: 14-question NCSC check, saved progress, free non-expiring access, illustrative result and separately priced service. How-it-works CTA was removed in #372; no standalone how page exists. |
| FAQ | Verified no standalone FAQ page, FAQ section or routed FAQ entry in the public source; no page created. |
| About (`/about.html`, `/About.html`) | Verified no-change redirects to `/` in server and SWA config; no separate About copy. |
| `pricing.html` — plans/frameworks | Separate page-group draft needed: name both planned paid assessments directly and link their roadmap entry without publishing a price. Leave #543's managed-security scope lines untouched. |
| `managed-it.html` — services | Verified no change: services are separately scoped and priced; its dashboard paragraph already marks automatic updates and connected feeds planned. No new free-dashboard entitlement is promised. |
| `scope.html` | Verified no change: access-checked service guide shell; expressly service information, not a signed agreement. |
| `insurance.html` | Verified no change for Stream H: free check, top gaps and separate paid summary. #490/#493 own campaign journey and sample-link changes. #541 owns setup referrer handling. |
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

- #543 remains open at `a4e2af6541a4fdc89c873deebd5d1b1fd96eccea` and changes
  `pricing.html` managed-security scope plus `test/publicPricingPage.test.js`.
  The planned-assessment paragraph and a separate test file avoid those edits.
- #546 merged as `28b434f50305e9775efcb4b70eeba52d8ef5e5ab` and is in the
  released `79239e9`. No duplicate activation-readiness work is needed here.
- #501/#518/#528/#529/#530/#538 are merged; their gated runtime remains off.
  Public price absence is intentional. Activation-copy alignment belongs to #500.
- Open #477/#484/#490/#493/#539/#541 own campaign, signup and authenticated
  result work; no edits to those page groups or runtime files here.
- Older roadmap proposals are retained as grouped planned themes. Removing
  “audit-ready” marketing language does not change the existing legal limitation.

## Verification and review

Run generated parity, feature-status, public navigation/legal/copy checks, the
static build and `scripts/accessibility/roadmap.cjs` for keyboard, sources,
375px stacking and desktop columns. The established public accessibility suite
also exercises the built roadmap at 320px/1280px and doubled text.
Independent copy review is required before signoff; exact-head CI is reported in
each draft PR, not inferred from the released baseline.

Independent copy review completed for the final wording: it required separating
N/A review from scoring v2 and retaining the distinct planned contact-request
workflow. Both corrections are present. The review's final N/A sentence is used
verbatim, so no later review of an existing answer is promised. The paid copy,
quarters, historical empty states, source disclosures and legal limitation passed.

Local targeted verification: 67 tests across eight public-page suites passed;
built Chromium checks at 375px and 1440px passed keyboard skip/jump/disclosure
navigation, no overflow, ordered stacking/five columns and axe (zero violations,
zero incomplete results). Browser traffic was loopback GET only. Full application
and hosted native PostgreSQL checks remain reported separately on the draft.
