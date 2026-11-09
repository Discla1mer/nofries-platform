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

## Third pass

Fixed on this branch:

- **Sign out.** After a customer signs out, the next sign-in asks Microsoft
  for credentials again (`prompt=login`), so a shared computer does not
  reopen the last account. The marker clears on the next completed sign-in.
- **Automatic save.** Answers save about 45 seconds after the last change,
  and when the page is hidden. Saving stops while 27 of the assessment's 127
  revisions remain, so manual Save and Submit always work.
- **Progress.** One line: answered, to go, to check later, and saved state.
- **Waits.** Sign-up buttons now show "Working on it. This can take up to
  20 seconds." as soon as they are pressed.
- **Schedule wording and r4.** The plan `nf-starter-2026-11-r3` pins the r4
  agreement and lists the Improvement Plan as "included when it is
  released". It is in source but not selected. The steps to turn it on are
  in `docs/legal/drafts/nf-dashboard-2026-11-r4-changes.md`.

Not changed:

- **The waits themselves** (7–10 s to terms, 9.5–19 s to the dashboard) were
  not shortened. Finding the slow step needs production timings for the
  setup and acceptance requests.
- **Browser Back after the callback (AADSTS900561).** The callback already
  redirects with 303. Back returns to Microsoft's own page, which re-posts
  an expired request. This can't be fixed in the app's source.
- **NZBN:** kept as free text while testing, as decided.
- **Turning on r3/r4:** legal review, the database proposal, the terms
  archive, the launcher setting and `/terms.html` (see the r4 change note).
- **Entra settings** in the section above.

## Fourth pass: navigation and Roadmap/News

Fixed on this branch:

- **One set of links.** Home, Roadmap, Managed IT, Contact, Privacy, Terms,
  the pilot terms and the error pages share the header links Dashboard,
  Managed IT, Roadmap, News, Contact and Log in, and the same footer plus
  Privacy and Terms. Before, the header on Contact, Privacy and Terms said
  "Managed IT" but opened the Dashboard home, and Roadmap's header links
  were hidden on phones.
- **Staff links** (`/operator`, `/portal`, `/scoping`) are no longer in shared
  navigation. Managed IT keeps the scoping and portal links in its staff
  section.
- **Sales Agency** is no longer linked from nofries.nz pages, matching the
  homepage. News and the Sales site still link to each other.
- **Roadmap and News.** The Roadmap is the one place for status; the empty
  "Ready for release" section is gone. News becomes "What's new." and points
  to the Roadmap instead of repeating status labels. The News change is in
  `sites/news/` and must be published separately (see its README).

Not changed: the sign-up and Report a bug pages keep their short "Back to
home" headers, so the task in front of the visitor stays in focus.

## Test data written to production

Accounts on the Mailosaur server `t0tolra0` (`smoke1`, `margaret.wilson`,
`raj.patel`, `aroha.cafe`, `sam.keys`, `chris.morgan`, `alex.qa`, `alex.qa.1`
and a partial `alex.qa.2`), their organisations, six submitted assessments
and four Ask Fry questions. Remove them from the tenant and database.
