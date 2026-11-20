# Questionnaire answers: synthetic browser evidence

Captured with `node scripts/tests/questionnaire-answers-browser.cjs`, using the
existing synthetic submitted assessment and the real dashboard renderer and CSS.
All source answers in this fixture are Yes. Missing backup-storage, patch-speed
and EDR details still show Not answered. No real customer or service is involved.

- [375px viewport](viewport-375.png) and [complete section at that viewport](answers-375.png).
- Actual Chromium A4 PDF raster captures: [page 3](print-page-3.png), [page 4](print-page-4.png).
- [Browser receipt and source hashes](receipt.json).

The browser check verifies no horizontal overflow, all nine questions, the real
clipboard, denied-clipboard selection fallback, the Print button's native
beforeprint event, PDF text and footer, hidden print controls, and zero transport
writes. Print uses the existing whole-results print behavior. This is desktop
Chromium at a mobile viewport, not a physical phone or a hosted sign-in test.

## Mapping assumptions for review

Mappings are pinned to the existing 14-question catalogue. They do not use scores,
free-text rationale, the proposed v2 profile, or new server data.

- MFA, restore testing, phishing guidance and payment checks use the accepted
  question and its guidance. Yes means the respondent reported all parts in
  place across their declared scope; No means none are in place. No particular
  restore-test frequency, training frequency, MFA method or insurance standard
  is asserted. A broader Partial answer cannot identify those specific details,
  so it yields Not answered.
- Incident response and access/admin-rights questions follow their source
  controls: Yes / Partial / No become Yes / Partly / No.
- Offline or immutable copies, patch deadlines and endpoint protection/EDR stay
  Not answered. Protected backups, a patch process, logging or application
  control cannot establish those details.
- Unknown, missing, unrecognised, duplicate, unsupported-profile and Not applicable
  answers cannot establish a control. They yield Not answered, never Yes.

These assumptions and open mapping questions are also recorded on the draft PR.
