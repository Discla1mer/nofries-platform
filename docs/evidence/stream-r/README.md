# Public text contrast, 19 November 2026

Live GET /api/health reported release b383ff09b5b82e62bf38d10f29417a75f150d5a3, build 44460031729 before and after the scan. The candidate uses that same main plus this PR's style.css change. The ad comparison uses the same main with PR #459 (b69946525d31a8f3ca37fbca3483a453ffb0fd4a) merged in a separate worktree, before and after applying the candidate stylesheet.

## Axe counts

Each cell gives confirmed violation nodes before → after. Live → local candidate for released routes, local #459 → local #459 plus candidate for ad routes. All rows include critical and serious rules. The four JSON files also retain per-route incomplete rules and node counts for manual review.

| Page or demo state | 375 × 900 | 1280 × 900 |
|---|---:|---:|
| Home | 0 → 0 | 0 → 0 |
| Pricing | 0 → 0 | 0 → 0 |
| Managed IT | 0 → 0 | 0 → 0 |
| Contact | 0 → 0 | 0 → 0 |
| Privacy | 0 → 0 | 0 → 0 |
| Sample result | 0 → 0 | 0 → 0 |
| /try, public demo dashboard Overview | 0 → 0 | 0 → 0 |
| Demo, View saved assessment → Assessment results | 0 → 0 | 0 → 0 |
| Roadmap | 0 → 0 | 0 → 0 |
| Board | 0 → 0 | 0 → 0 |
| Insurance | 0 → 0 | 0 → 0 |
| Invoice scams | 0 → 0 | 0 → 0 |
| Supplier questionnaire | 0 → 0 | 0 → 0 |

## Manual contrast

The paper tile is opaque, 836 × 836 pixels. Decoding images/paper-texture.webp (SHA-256 3dcb6372a6e724adf66f1b2ec5a749be4fd76bdcc594b74b9a8e77d7c8fef946) and taking the minimum WCAG relative luminance across all 698,896 pixels gives #aea191. For dark text this gives a conservative lower bound wherever the paper repeats. Inspected computed foregrounds on transparent ancestors up to the textured background, including the Pricing enquiry link, header navigation, and #459's “No card needed” helper.

| Ink against darkest paper | Before | After | Tile pixels below 4.5 before → after |
|---|---:|---:|---:|
| Muted #544c41 → #3a342b | 3.34 | 4.87 | 23,313 → 0 |
| Accent #65470d → #4d350a | 3.38 | 4.54 | 18,404 → 0 |
| Dark accent #5c410c → #443009 | 3.75 | 4.97 | 1,120 → 0 |

For reproduction, convert each 8-bit sRGB channel to 0–1, linearize it, and use 0.2126 R + 0.7152 G + 0.0722 B. Count background pixels where (Lbackground + 0.05) / (Link + 0.05) < 4.5.

D-014 demo spot checks at 375px: “Coming next” and “With an account” render at 16px in #40382e on #f6f2ea (10.32:1). Scope helper text uses #40382e on #ece6da (9.27:1). #462 already handled the authenticated “About this site” footer. Authenticated views were outside this audit. Home, Roadmap and the Results wording remain with Stream O. The Home and Managed IT incomplete ARIA results remain manual-review items.

## Reproduce

Install the scripts/accessibility lockfile with npm ci --prefix scripts/accessibility. The run used Playwright 1.64.1, axe-core 4.14.0 and Chromium 154.0.8037.57. Browser requests allow same-origin GET only. The live browser used the environment's HTTPS proxy with its private CA; the runner's AUDIT_PROXY_TLS=1 option allows its certificate in the isolated browser context.

From the repository root:

```sh
node scripts/accessibility/stream-r.cjs https://nofries.nz /tmp/live.json / /pricing.html /managed-it.html /contact.html /privacy.html /sample-result.html /try '/try#results' /roadmap.html
```

For local pages, start the application on loopback and substitute its origin. For /try, run node scripts/build-static.js and serve dist with /try rewritten to /app/try.html as in staticwebapp.config.json. The #results audit label instructs the runner to open the seeded saved assessment and wait for its results heading. For #459 use a disposable checkout of the same base with its branch merged, then run the same command with /board.html /insurance.html /invoice-scams.html /supplier-questionnaire.html. Repeat with this PR's style.css applied. Representative mobile captures accompany the route results.
