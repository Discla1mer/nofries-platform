# Live usability test follow-up (November 2026)

Six simulated personas (a 65-year-old non-technical user, an impatient power
user, a 320px phone user, a keyboard-only user, a first-time visitor and a
tester trying to break things) signed up on https://nofries.nz and submitted
a first Cyber Security assessment. This note lists what is fixed in source,
and what needs a tenant setting or an owner decision.

## Fixed in source on this branch

| Finding (testers) | Change |
| --- | --- |
| "Next question" and "Submit" moved focus off-screen (4/6) | The new question scrolls into view; after submit, focus and scroll go to the submission note, shown in NZ time. |
| No way to copy the IT provider summary (4/6) | "Copy summary" button with a select-the-text fallback. |
| "Help me answer" promised AI that is switched off (2/6) | Without AI, the panel is "How to answer this question" with no AI wording. |
| Terms screen: price and limits buried in about 44 phone screens (6/6) | "At a glance" box quoting the schedule's price, access period, allowance, included and excluded lines, above the unchanged full schedule. |
| Cancel on the hosted password page showed a bare 401 (1/6) | A plain GET to the external sign-in callback redirects to the existing sign-in recovery page. |
| Cost and size unclear before sign-up (5/6) | Homepage line: free to start, no card, 14 questions for NZ small businesses. Sidebar "Dashboard subscription" is now "Your plan". |
| Ask Fry opened off-screen on a scrolled phone (1/6, reproduced) | The dashboard-bar reserve only applies to a bar docked at the viewport bottom and never exceeds its height. |

## Microsoft Entra External ID settings (no code change)

These were seen on the hosted `nofriescustomers.ciamlogin.com` pages.

1. **Permissions screen on every sign-up (5/6, near-blocker).** Grant
   tenant-wide admin consent for the customer app's delegated scopes so
   customers never see "This application is not published by Microsoft" or
   "Does this app look suspicious?". Rename the app registration from
   "No Fries Customer Web External" to "No Fries", and complete publisher
   verification. Drop `offline_access` if refresh tokens are not used.
2. **Branding (6/6).** In Company branding, set the tenant display name to
   "No Fries" (the code email currently reads "No Fries Customers's apps"),
   and add the logo, background and a privacy link. In custom CSS use
   16px inputs (iOS zooms on 15px), buttons at least 44px tall, and a visible
   focus outline on text fields.
3. **Sign-up flow dead ends (Alex, reproduced twice).** Back on the first
   "Create account" page switches to sign-in; the correct code then fails
   with AADSTS50020. One wrong code returns to the email step, where Next
   does nothing. Review the user flow's sign-up/sign-in settings, hide Back
   on the first page if the page layout allows, and confirm the code step
   offers "Resend code". Codes with spaces are rejected and a double-clicked
   Next sends two different codes; check whether the flow version in use
   supports trimming and button debouncing, otherwise raise it with Microsoft.

## Product and legal follow-ups (second pass)

Fixed on this branch:

- `/terms.html` is now the dashboard terms, built from the reviewed draft
  with No Fries Limited named as the provider. It includes a plain
  explanation of the CGA s 43 and FTA s 5D business-only exclusions and the
  rights that cannot be excluded. The staff pilot workspace terms moved
  unchanged to `/pilot-terms.html`.
- `/privacy.html` opens with a dashboard summary covering the agency,
  information collected, purposes, storage, recipients, retention, Privacy
  Act 2020 access and correction rights (with 20 working days to respond),
  complaints to the Privacy Commissioner, and breach notification.
- The setup checkbox now says "authorised to set up this organisation and to
  accept its terms on its behalf", matching the agreement. A "Save a copy of
  these terms" button downloads the exact schedule and agreement.
- The Roadmap no longer says sign-up is "still being tested" or describes
  repository moves. Ask Fry states the complimentary starter facts.
- Results lead with a plain verdict. "Supporting evidence" reads "None
  recorded" when nothing is recorded. The footer time is in NZ time. "Open
  assessment" from the Overview starts a new assessment directly when none is
  saved. Escape closes the More tools and Account menus.
- `docs/legal/drafts/nf-dashboard-2026-11-r4.txt` is a draft agreement
  (not operative) that raises the complimentary cap and adds a separate
  privacy and confidentiality limit for the unfair contract terms rules. See
  its change note.

Still open:

- **Sign out keeps the Microsoft session (security).** Needs front-channel
  logout or `prompt=login` after sign-out. It touches the authorisation URL
  checks in `api/shared/browserAuth.js` and needs a reviewed change.
- **Browser Back after the callback** shows AADSTS900561.
- **Schedule "Improvement Plan" wording:** change it with the next approved
  plan version (see the r4 change note). It can't be changed in place.
- **Approve r4:** confirm the cap figures, get legal review, then create the
  plan version and digest.
- **NZBN:** kept as free text while testing, as decided.
- **Autosave:** not added. Each save uses one of an assessment's 127
  revisions, so per-answer autosave could exhaust them. Consider saving on
  page hide or a timer that batches answers.
- **Waits:** workspace Continue to terms took 7–10 s, and terms to dashboard
  9.5–19 s. Profile the access checks.
- **Progress counters:** merge the three status lines into one.

## Test data written to production

Accounts on the Mailosaur server `t0tolra0` (`smoke1`, `margaret.wilson`,
`raj.patel`, `aroha.cafe`, `sam.keys`, `chris.morgan`, `alex.qa`, `alex.qa.1`
and a partial `alex.qa.2`), their organisations, six submitted assessments
and four Ask Fry questions. Remove them from the tenant and database.
