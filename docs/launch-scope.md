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
