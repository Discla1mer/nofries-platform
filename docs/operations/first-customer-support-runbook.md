# Customer #1 support runbook and contact audit

**Proposed operating procedure for Joel's approval; not a published SLA.** Reviewed 5 November 2026 NZDT. Documentation only: no email sent, form submitted, account inspected or changed, workflow dispatched, or support/billing service activated. Public GET observations are separated from authenticated source inspection below.

## Decision note

Recommend **hello@nofries.nz as the customer-facing inbox**, with Joel as accountable first responder and a named backup. Continue monitoring **joel@nofries.nz**, which receives the current report composer's email drafts, until a separately reviewed change consolidates the route. Delivery, mailbox access/coverage and any forwarding were not tested or configured here. Give customer #1 the approved contact/hours directly during onboarding; do not depend on the unavailable enquiry page or on Ask Fry to open a ticket.

**Joel decides before promising support:** inbox and backup owner; staffed hours/holidays; targets below; private case/evidence location and retention; an urgent contact/escalation route; and whether support is included in the agreed paid scope. No 24/7 monitoring, response or resolution guarantee is implied. The [paid-access note](first-customer-paid-access.md) and [#74](https://github.com/Discla1mer/nofries-platform/pull/74) must agree with the final customer wording.

## Proposed response targets

Coverage proposal: 09:00–17:00 Pacific/Auckland, Monday–Friday excluding NZ public holidays; Joel to confirm applicable holidays and backup coverage. The clock runs only during these hours. Targets are human acknowledgement and update targets, **not resolution deadlines or contractual promises** until approved.

| Priority | Example | Acknowledge | Update / escalation |
| --- | --- | --- | --- |
| P1 | Customer cannot sign in/save/submit; suspected loss or unauthorised access | Within 2 support hours | Notify Joel and Fry as soon as seen; update at least every 2 support hours while unresolved. Route privacy/security concerns privately to the appointed privacy officer immediately when detected. |
| P2 | One workflow impaired, safe workaround available | Within 1 support day | Update each support day; escalate to Fry if unresolved after that first day or impact increases. |
| P3 | How-to, wording or feature request | Within 2 support days | Give an owner and next review date; no delivery-date promise for roadmap work. |

After-hours cases enter the next staffed period; a separate urgent/on-call arrangement must be explicitly agreed if required. For an active cyber incident, the customer should use its own incident-response arrangements; dashboard support is not an incident-response service. Suspected privacy breaches follow the appointed officer's process and applicable notification duties, not an invented “support SLA” deadline.

## Intake and triage

1. Assign a case ID in Joel's approved private case system (or a restricted register if that is the agreed initial process). Record received time/timezone, verified reply contact, affected organisation, step/page **path without query tokens**, expected/actual behaviour, impact and next update. Record only a provided safe `NF-…` diagnostic reference/error code; do not solicit passwords, verification codes, cookies, copied network requests or whole assessment answers.
2. Acknowledge with case ID, owner, priority, next update and a safe workaround if known. Opening the report page or an email draft is not receipt of a case. Do not claim delivery until the monitored inbox actually receives it. Ask the customer to check sent mail before repeating a report.
3. Check public reachability and known incident/release notes read-only. Do not ask someone to repeat signup, submit another assessment or abandon unsaved work to diagnose a failure. Reproduce using synthetic data locally where possible. Redacted screenshots only if necessary and via the approved private channel; the public report composer explicitly tells users not to include screenshots/private account details.
4. Verify identity/representative authority proportionately before disclosing account facts. An email address, organisation name, sales customer record or payment receipt alone does not authorise dashboard access or account changes. Privacy requests go to the process in [#74](https://github.com/Discla1mer/nofries-platform/pull/74), even if login is unavailable.

## Read-only account lookup through #47

This is an operator procedure **after #47 is deployed and qualified**, not evidence that the portal is live. Reviewed head: `685636aea724491bb4eed2d1c974e16a709f0948`; [PR #47](https://github.com/Discla1mer/nofries-platform/pull/47). Use only already-authorised staff access. This runbook grants no role and does not authorise changing one.

1. Open `/dashboard-admin/entry` on the approved app host and use the staff sign-in path. Confirm administration capability. If access is denied, unavailable or the feature is absent, stop and escalate to Fry; do not use a customer login, bypass the gate or request extra permissions as a workaround.
2. In **Signups → Search accounts or organisations**, search the verified email/organisation. Search is bounded to the authorised population; page/limit warnings matter. “No match” is not proof the account does not exist. The queue shows recorded milestones, not current access or payment status.
3. Obtain the canonical provider (`legacy`/`external`), immutable subject key and exact tenant/organisation IDs from existing authorised identity/binding evidence. The signup list does **not** itself display those identifiers. If unavailable, ask Fry for an authorised scoped lookup; do not infer them from email or a Sales record.
4. Enter those identifiers in **Exact identity lookup → Look up identity**. Review organisation state, effective memberships/roles and validity, invitations, entitlement validity/limits, usage, revisions and evaluated time. “Unknown”, “ambiguous” and “unavailable” mean stop/escalate, not “no account”. Check the selected client for consultant accounts. Record only case-relevant IDs/status/reason codes privately.
5. Classify the fault: identity/session, incomplete setup/admission, wrong organisation/membership, expired entitlement/limit, or app error. Escalate with that evidence. A recorded activation milestone is not a fresh access decision, and an entitlement is not evidence that an invoice was paid.
6. Finish the lookup without using account-action controls. #47's access removal/restoration, labels and archive require a separate authorised change with preview, confirmation and audit. Archive retains data; it is not erasure. Empty-signup reset is disabled pending the fence work; do not use it as a support shortcut or for accepted customers. Paid-term management also needs the separate bridge described in the paid-access note.

Source anchors: [admin document](https://github.com/Discla1mer/nofries-platform/blob/685636aea724491bb4eed2d1c974e16a709f0948/lib/dashboardAdminDocument.js), [bounded signup search](https://github.com/Discla1mer/nofries-platform/blob/685636aea724491bb4eed2d1c974e16a709f0948/api/shared/protectedAssets/signupQueue.js), [scoped lookup](https://github.com/Discla1mer/nofries-platform/blob/685636aea724491bb4eed2d1c974e16a709f0948/api/shared/protectedAssets/dashboardAdmin.js).

## Escalation and closure

- **Joel:** customer communication, impact/priority, commercial scope/refunds and named backup. **Fry:** technical triage and release coordination; implementations remain scoped PRs. An incident report is not approval to deploy, reset, change permissions or alter customer data.
- **Privacy/security:** notify the appointed officer/incident owner privately as soon as detected, preserve necessary restricted evidence, and avoid further exposure. No raw account information, customer correspondence, assessment content, financial records or unsanitised logs in public issues or #686. Use #686 only for sanitised release blockers, code/error categories and PR/check links; private ownership of that issue does not make it a customer-data repository.
- **Provider outage:** the authorised provider owner investigates through the existing support arrangement; never request keys or create a new billing/support account from this runbook. Give the customer the next update even when there is no fix yet.
- **Close:** record the cause or remaining uncertainty, approved fix/workaround, validation and customer confirmation (or a documented follow-up date). Retain only the necessary support record under the schedule Joel approves with #74. Review P1 incidents for prevention and link an appropriate code issue without customer data.

Suggested acknowledgement: “Case [ID]: we received your report about [safe step]. [Owner] is checking it. Our next update is [time, NZ timezone]. Please do not send passwords, codes or private assessment content.” This is a template, not a message sent by this task.

## In-app help/contact link audit

Source baseline: public main `00bf0f0f85990bc95f9bf060b612e934ea60894b`. Live public pages checked using unauthenticated GETs on 5 November NZDT; no form/chat submissions, mailto activation, IdP navigation or authenticated UI. HTTP success proves reachability only, not email delivery, full keyboard behaviour or live authenticated wiring. Fragment checks are source/HTML checks; query/fragment values may alter client UI rather than identify DOM anchors.

| Priority / surface | Exact element or destination | Finding | Suggested owner action |
| --- | --- | --- | --- |
| P1 before promoting enquiry | `https://nofries.nz/contact.html` | **404**; custom page includes a broken-link report link. | Enquiry owner: release/verify #42 → #60 → #43 and actual mail delivery before promoting this path. #42 now documents safe fallback, but an open PR is not live delivery. |
| P1 operational ownership | Legal/Managed IT support versus report recipient | Privacy, terms and Managed IT link `mailto:hello@nofries.nz`; report composer uses `joel@nofries.nz`. No inbox/delivery coverage verified. | Joel: name one monitored primary route plus cover; keep both existing destinations monitored until a separate reviewed alignment. Do not silently reroute mail here. |
| P2 human support discoverability | `/` and `/login` header/footer/help | Both **200**; reviewed HTML has no direct support-email/report anchor in the normal entry UI. Privacy/terms are reachable but are indirect ways to find support. | Product owner: add a persistent Contact support link and safe failure-state route in a separate UI PR; retain the existing signup/sign-in path. |
| P2 dashboard help discoverability | `app/dashboard.html` footer; shared assistant | Source footer exposes Roadmap/News; shared helper footer exposes No Fries/Roadmap/Privacy, without a direct human support route. Authenticated rendering not exercised. | Dashboard owner: expose Contact support/Report a problem without losing unsaved work; validate final composed app, including mobile/text zoom. |
| P2 expectation mismatch | `/report.html`, `#report-open`, `#report-copy` | **200**. “Open email draft” prepares mail to Joel; manual send required. Copy and direct-address fallback exist; no server ticket receipt. | Preserve explicit unsent/delivery wording; use inbox receipt to start response targets. Mail-client behaviour and inbox delivery remain unverified. |
| P2 channel boundary | Ask Fry `[data-shared-assistant]` / `#nofries-assistant-boundary` | Live home/login HTML says public help, no access to organisation/forms/assessments. Source marks dashboard help-only; Managed IT uses the prospect conversation path. | Keep secrets/customer evidence out; add an obvious human handoff in a separate UI PR. Do not advertise account support, a ticket or a guaranteed response from chat. |
| Pass destination; source-only entry | `lib/signupDocument.js` “Report a bug or give feedback” → `/report.html#kind=feedback&screen=signup` | Target **200**; source opens a new tab with `noopener noreferrer` and a new-tab accessible label. Signup failures also construct bounded report context. | Preserve this route and redaction. Confirm deployed authenticated setup/error placement during owner acceptance; no live signup attempt made here. |
| Pass destination | `/managed-it.html` “Discuss pricing” → `#enquire`; `.managed-it-email` | **200**; enquiry fragment exists and email link targets hello. This is a sales/service enquiry route, not proof of paid dashboard support. | Keep the distinction and the email fallback. |
| Pass destination; policy pending | `/privacy.html`, `/terms.html` “Support”; `/roadmap.html` | All **200**; legal support links target hello. Roadmap links are product information, not support intake. | Coordinate final legal wording with #74; do not turn proposed support targets into a live SLA through copy alone. |
| Restricted / source-only | `/support`, `/portal` and legacy `js/app-loader.js` support fallback | Staff Service desk and scoped customer portal are separate existing surfaces; legacy loader offers hello on failure. They are not established as the paying dashboard customer's universal support route. | Do not send unauthorised customers to staff `/support`; validate portal entitlement separately. No authenticated routes were opened in this audit. |

Evidence files: [report HTML](../../report.html), [report composer](../../js/customer-report.js), [signup document](../../lib/signupDocument.js), [signup diagnostics](../../api/shared/customerSignup/signupJourney.js), [dashboard template](../../app/dashboard.html), [shared helper](../../lib/sharedAssistantDocument.js), [helper composition](../../lib/withSharedAssistantDocument.js), [Managed IT](../../managed-it.html), [legacy support fallback](../../js/app-loader.js). Known queued contact delivery: [#42](https://github.com/Discla1mer/nofries-platform/pull/42) at `89583d7a168eb15298b11d039be99e68f3153414`; no contact/CSS/code changes are included here.

## Before using this runbook for customer #1

Joel approves the operating decisions and tells the customer the agreed contact/hours; a separately authorised check proves actual mailbox receipt and backup coverage; the admin owner demonstrates restricted lookup on the released #47; the commercial agreement matches the supported service; and privacy/support records have an approved restricted location and retention. Until then these are readiness tasks, not assurances already delivered.
