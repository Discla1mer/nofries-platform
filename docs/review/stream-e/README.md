# Stream E review evidence

These are real Chromium screenshots at a 375 × 844 CSS-pixel viewport, using
synthetic loopback fixtures and the production documents, JavaScript and CSS.
No real identity provider, acceptance, customer data or email is involved.

| Step | Screenshot |
| --- | --- |
| Default-off sign-up | [Full details](01-flag-off-signup.png) |
| Flag-on sign-up | [Organisation and authority](02-flag-on-signup.png) |
| Separate deliberate acceptance | [Terms step](03-terms.png) |
| Existing questionnaire | [Question one](04-question-one.png) |
| Result before personal details | [First result](05-first-result.png) |
| Board/insurer summary gate | [Details required](06-summary-gate.png) |
| Later collection | [Name, role and address](07-later-details.png) |
| After save and reload | [Summary available](08-summary-ready.png) |

Reproduce from the repository root with `node scripts/tests/stream-e-browser.cjs`.
It requires Playwright and Chromium; set `CHROMIUM_EXECUTABLE_PATH` if Chromium
is not at `/usr/bin/chromium`. Output defaults to `/tmp/stream-e-browser`; the
runner rejects an output directory inside the repository. The checked-in
[receipt](receipt.json) records the browser assertions, one details write and
one audit event, with no page errors, external requests or unmatched routes.

The browser runs the sign-up steps through question one, then loads a synthetic
submitted result produced by the existing evaluation engine. It does not pretend
to complete all 14 questions or authenticate against a provider. The native
PostgreSQL tests separately create, save and submit an assessment through the
real authenticated HTTP handlers, then exercise the gate and immutable save.
The browser's unconfirmed-save case returns a synthetic 503 after a successful
write; retry and reload recover the same record. Cancel saves nothing.

## Integration with Stream D

E leaves the questionnaire, its question order, answer controls, scoring,
revision contract and submission transaction alone. D can change that experience
behind its own flag. After the existing acceptance/admission path, both variants
enter the same Cyber Security module and question-one route. E considers a
persisted submitted assessment in the selected organisation to be a first result;
drafts do not qualify. No D implementation is included here.

After D lands, repeat this browser run with D both off and on, checking that its
first-result navigation reaches the existing overview and that E's host-supplied
`detailsGate` still wraps board-summary generation and service entry points.
The authenticated contact-request API enforces the same gate independently.
Public contact pages remain outside this authenticated workflow. The existing
general results summary is available; the board/insurer summary is gated.
