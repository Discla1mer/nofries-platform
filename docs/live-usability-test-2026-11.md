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

## Needs an owner decision or a reviewed auth change

- **Sign out keeps the Microsoft session (security).** After "Sign out",
  "Sign in again" re-entered the dashboard without a password. Options:
  front-channel logout to the tenant's end-session endpoint with a
  registered post-logout redirect URI, or sending `prompt=login` on the
  next sign-in after a sign-out. Both touch the authorisation URL checks in
  `api/shared/browserAuth.js` and need a separately reviewed change.
- **Browser Back after the callback** shows AADSTS900561 (the provider's
  form_post page re-requested by GET). Consider redirecting from the
  callback with a history-replacing page.
- **Public legal pages.** `/terms.html` still holds the pilot "sales
  discovery and proposal tool" terms, not the dashboard agreement shown at
  sign-up; the Roadmap says "Fresh signup… still being tested". The schedule
  lists the Improvement Plan as included while the dashboard shows it as
  "Coming next".
- **Results.** Testers wanted one plain verdict ("6 to fix, 7 to check")
  above the percentage ranges, and no "Supporting evidence 0.0%" while
  uploads are disabled.
- **NZBN.** Letters are accepted. Existing tests require the field to accept
  any registration text; switching to a 13-digit NZBN check is a product
  decision.
- **Waits.** Workspace Continue to terms took 7–10 s and terms to dashboard
  9.5–19 s, including a silent extra sign-in round trip. Profile the access
  checks after setup and after acceptance.
- **Smaller items.** Autosave answers, raw UTC footer "Display snapshot"
  stamps, a single progress line instead of three counters, "Open assessment"
  going straight to the scope step, and Escape closing the Account and More
  tools menus.

## Test data written to production

Accounts on the Mailosaur server `t0tolra0` (`smoke1`, `margaret.wilson`,
`raj.patel`, `aroha.cafe`, `sam.keys`, `chris.morgan`, `alex.qa`, `alex.qa.1`
and a partial `alex.qa.2`), their organisations, six submitted assessments
and four Ask Fry questions. Remove them from the tenant and database.
