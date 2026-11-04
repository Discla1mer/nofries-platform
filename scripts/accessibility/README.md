# Public-page accessibility gate

Run `node scripts/build-static.js`, then `npm ci --prefix scripts/accessibility`
and `node scripts/accessibility/node_modules/playwright/cli.js install chromium`.
Run `node scripts/accessibility/public-pages.cjs`. An existing Chromium can be
selected with `CHROMIUM_EXECUTABLE_PATH`. Results default to
`/tmp/nofries-public-accessibility.json`; `NOFRIES_A11Y_RESULTS` selects a file.
`NOFRIES_A11Y_ROOT` selects an already-built comparison checkout, never a URL.

The separate public-accessibility workflow leaves ordinary CI, root dependencies,
release pins and the visual owner's styles untouched. All actions and tools are
pinned; the isolated lockfile is audited. It has no secrets or write permissions,
no dispatch trigger and no production network access from the browser. Installation
uses the package/browser registries; the test itself permits only loopback GETs.
Account/session responses are synthetic. No forms or chat messages are submitted.

Seven built public pages are checked at 1280 and 320 CSS pixels, at 100% and 200%
text, with help open and closed: home, login, Managed IT, privacy, terms, roadmap
and report. The contact form joins automatically when #42 supplies it; its absence
is printed as a deferred capability, not a pass. Text enlargement snapshots every
computed font size before doubling it, verifies the actual resulting sizes and
leaves the viewport/device scale unchanged. This is a text-resize simulation,
not browser chrome zoom. No screenshot-only clipping is used to simulate mobile.

Axe runs all WCAG 2/2.1/2.2 A/AA tagged rules without exclusions. Violations, page
errors, unexpected requests, horizontal overflow and clipped text fail the job.
Incomplete axe results remain in evidence for manual review (not reported as
passes). In particular gradients require human contrast review. This is not an
AA certification and does not test identity-provider pages or live delivery.

A signup error probe uses `.signup-field-error` inside the candidate's actual
`.organisation-card`, so it fails if #58's pale error colour is combined unchanged
with #32's cream card. The probe is test-only and never writes source CSS. Negative
and positive controls reproduce #58 `9c84dfc` ink `#ffb59e` on #32 `f8b7b11` paper
`#f6f2ea` (1.52:1), and the existing visual dark red `#a3352a` (6.07:1), respectively.
The negative MUST be detected by axe. The unmodified candidate must independently
pass at 4.5:1; a successful negative control cannot exempt a candidate failure.
These controls do not claim full-stack or refreshed-persona qualification.

The report guidance is persistent HTML with the existing `.report-help` style.
Its association, visibility while typing and 4.5:1 contrast are asserted. Nothing
is sent. The check is deliberately strict: visual-owner CSS failures stay red,
without allowlists, skipped rules, raised tolerances or `continue-on-error`.
See private NoFries#686 for the handoff of unresolved layout/token corrections.

## Tool licences

The test-only lockfile pins Playwright/playwright-core (Apache-2.0) and
@axe-core/playwright/axe-core (MPL-2.0). Their upstream licence notices remain in
the installed packages. These tools are not included in the application bundles.
