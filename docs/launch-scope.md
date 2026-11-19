# Launch scope: first paying customer

Status of `main` at `22f126f` for the journeys a first paying customer needs.
**Ready** means the journey is composed end to end in source and covered by the
existing test suites. It says nothing about the live site: which build is
deployed, which flags are set and whether a real customer has completed the
journey are release questions for the owner. Board reports and assessment
comments are post-launch (issue #11).

| # | Journey | Status | Gap PR |
| --- | --- | --- | --- |
| 1 | Sign up and reach the dashboard | Ready | — |
| 2 | Complete the NCSC assessment (answer, save, submit) | Ready | — |
| 3 | See assessment results | Ready | — |
| 4 | Generate and work the improvement plan | Ready | — |
| 5 | Pay for access in the app | Gap | None open |

## What each row rests on

1. **Sign up.** `/signup` runs the customer signup runtime
   (`lib/customerSignupProduction.js`). Starter signup
   (`lib/starterSignupProduction.js`) provisions the organisation, terms,
   admission and dashboard entitlement for Overview, Cyber Security and
   Improvement Plan (`api/shared/customerSignup/customerStarterPlan.js`). The
   journey ends at "Continue to your dashboard". Requires
   `NOFRIES_CUSTOMER_SIGNUP_ENABLED` and `NOFRIES_STARTER_SIGNUP_ENABLED`.
2. **Assessment.** `/api/dashboard/ncsc/assessments` lists, creates, reads,
   saves and submits (`docs/ncsc-assessment-api.md`). The dashboard bundles
   `ncscAssessmentClient.js` and `ncscQuestionnaire.js`. Submission needs a
   quota: a starter customer's quota comes from its own starter grant
   (`resolveStarterQuota`, composed in `lib/productionApplication.js`).
   Requires `NOFRIES_DASHBOARD_RUNTIME_ENABLED` and
   `NOFRIES_DASHBOARD_NCSC_ENABLED`.
3. **Results.** Shown immediately after submission and on reopening
   (`docs/ncsc-results.md`). Implementation attainment is shown. Evidence
   confidence, risk priority and trend are shown as "not assessed" or "not
   calculated" by design; that is a stated limitation, not a gap.
4. **Improvement plan.** `/api/dashboard/improvement/*` generates a plan from a
   submitted assessment revision, then supports assign, start, block, reopen
   and complete (`api/shared/improvementPlan/improvementPlanService.js`). The
   dashboard bundles `improvementActionPlanClient.js`. Requires
   `NOFRIES_DASHBOARD_IMPROVEMENT_ENABLED`.
   A new plan carries owners, due dates and open status from the newest
   same-scope plan; if that plan does not validate, nothing is carried, even
   if an older valid plan exists.
   **Contact request.** `POST /api/dashboard/contact-requests` with
   `{ operationId, topic, consentVersion }` records that a signed-in customer
   asked No Fries to contact them, about their results or one listed service
   (`api/shared/contactRequests.js`, table from migration 0026). One request
   per organisation, topic and New Zealand day; a repeat that day answers
   `{ status: 'already_requested' }` and stores nothing; a retry of the same
   `operationId` gets the same answer that day. Only a stored request is
   audited, so replays add no rows. Customer sessions only; staff operator sessions are
   refused. The dashboard has no button yet. Off
   unless `NOFRIES_CONTACT_REQUESTS_ENABLED` is exactly `true`; off, the route
   is a 404.
   **Staff email.** When a request stores a new row, and only then, one
   plain-text email goes to the enquiry mailbox (`NOFRIES_ENQUIRY_TO`, default
   `hello@nofries.nz`) after the transaction commits
   (`api/shared/contactRequestEmail.js`). It gives the organisation display
   name, the topic label and the NZ date, and points staff to the dashboard
   admin; it has no assessment content, no customer email address and no free
   text. It uses the enquiry delivery settings, needs
   `NOFRIES_ENQUIRY_DELIVERY_VERIFIED=true`, and takes one attempt from the
   shared enquiry email budget (`docs/enquiry-shared-rate-limit.md`); with the
   budget spent or delivery unavailable it is skipped. A retry, a same-day
   repeat or a failed send never changes the customer's answer; the outcome is
   logged as a code only. At most one email per organisation and NZ day: a
   second topic that day is stored but sends nothing. The display name is
   marked as customer-supplied, with control and Unicode format characters
   (bidi overrides, zero-width) removed. Off unless `NOFRIES_CONTACT_REQUEST_EMAIL_ENABLED`
   is exactly `true` (and the route is on).
   **Retention.** Contact requests are kept for 24 months from `requested_at`,
   then deleted. Account reset and delete remove them sooner. The automatic
   purge is built and off by default (#455): migration 0027 adds the NOLOGIN
   role `nofries_contact_request_retention`, which can see and delete only
   rows older than 24 months (row security) and read only their key and date;
   it cannot insert or update. A daily in-process job
   (`api/shared/contactRequestRetention.js`) checks that the database login may
   `SET ROLE` to it and does not inherit it (an inherited grant logs
   `retention_role_inherited` and deletes nothing), then deletes in batches of 500 (at most 20 a run), each
   transaction under `SET LOCAL ROLE` with a 15-second statement timeout, and
   logs only a code and a count. Off unless
   `NOFRIES_CONTACT_REQUEST_RETENTION_ENABLED` is exactly `true`. It also needs
   0027 applied and a separate production grant of the role to the App Service
   login, `WITH SET TRUE, INHERIT FALSE`; without the grant each run logs
   `retention_role_unavailable` and deletes nothing.
5. **Payment.** `server.js` answers every `/api/billing/*` request with
   `billing_disabled`. A customer cannot pay inside the app. Until this is
   built, a paid plan has to be approved by an operator and invoiced outside
   No Fries. No open public PR covers it; private-repo PRs were not visible
   when this was written.

## Known limits that do not block launch

- Evidence upload: assessment evidence starts as placeholders; there is no
  upload endpoint yet (`docs/ncsc-assessment-api.md`).
- An invited, non-starter organisation needs a published NCSC submission policy
  before it can submit. `createNcscPolicyPublisher` has no caller in this
  repository, so that path depends on private tooling.
- `docs/ncsc-assessment-api.md` links `customer-testing-smoke.md`, which does
  not exist in this repository.
- Dashboard checks are DOM-contract tests, not real-browser or device tests
  (`docs/dashboard-shell.md`).

## How this was checked

Code was traced from route to service on `main`. These suites pass locally
(11 suites, 907 tests): `customerProductionJourney`, `packagedCustomerJourney`,
`customerSignupJourney`, `ncscAssessmentHandlers`, `ncscAssessmentService`,
`ncscQuestionnaire`, `improvementPlanHttp`, `improvementPlanProduction`,
`improvementActionPlanClient`, `dashboardProduction`,
`dashboardRuntimeHandlers`.
