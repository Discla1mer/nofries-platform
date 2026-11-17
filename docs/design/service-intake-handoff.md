# Customer-initiated service handoff

The Services link shipped in #408 opens the existing enquiry form. A URL service hint or typed email cannot prove who signed in or which workspace they represent. The current email path remains the customer contact channel. This plan covers #409–413.

## Intake decision and transaction (#409)

The offline decideServiceIntake function describes the next staff-side action. Its arguments are trusted facts for a future adapter, never request-body flags. Signup, assessment submission, navigating to the form and abandoning it produce no lead. Record a contact request only after an explicit submission; its purpose is to answer that request.

For dashboard intake, recheck membership and workspace ownership at submission. Obtain the verified email from the authenticated identity. Count distinct lifecycle organisations by exact stored email equality across the complete authorised lookup. Do not trim, fold case, strip aliases or infer a relationship from names or domains. Multiple records, an incomplete search, a consultant client workspace or an unverified/public enquiry require staff review. A single match reuses the record at its current stage; zero matches creates a prospect only after a successful complete lookup.

Before connecting the adapter, Claude must confirm the production lifecycle store independently and obtain security review. Agree the ask location and obtain Joel's approval for any lead-table migration. Design a prospect-specific dashboard link scoped by both tenant and organisation. Preserve conflicts for manual review. Use a fixed, least-privileged system actor and server-enforced submission limits. In one transaction reserve a request key bound to actor, scope and payload, resolve the match under concurrency control, and record the decision and operator task. A repeated key with a changed payload must fail. Commit email delivery intent once and retry delivery separately. Reconcile uncertain delivery without creating another lead or task.

## Downstream review gates

| Stage | Authoritative input and expected result | Synthetic integration case before release |
| --- | --- | --- |
| Operator (#410) | Show stage and link state only through an authorised same-tenant, same-organisation link. Restrict plan and assessment fields separately. | An unresolved or conflicting link reveals no account details. |
| Scoping (#411) | Let the customer request contact without sharing an assessment. Separately disclose the summary fields and staff recipient; capture explicit consent bound to the request, organisation and submitted revision. Only then read scope, gaps and open actions as needs confirmation. | Omitted consent, wrong organisation or changed revision yields no assessment read or transfer. |
| Commercial acceptance (#412) | Require recorded acceptance of the specific proposal and service. Establish the governed customer-only nofries_dashboard / organisation reference after acceptance. | Enquiry and scoping leave paid status unchanged. Reject a conflicting reference. Review alongside the existing entitlement design in #80. |
| Onboarding and activation (#412) | Show accepted service as bought; start onboarding under existing staff controls. Show live only on authoritative service-specific activation. | Replayed acceptance creates one onboarding item. A delayed acceptance event cannot roll back activation; a second service stays independent. |
| Status and portal (#412–413) | Project the approved state read-only to the linked dashboard organisation's Services tab. Claude decides portal retirement timing after status is available. | A different tenant or revoked link cannot see status. Verify existing portal access during rollout. |

The executable tests cover routing decisions only. Transactional intake, consent records, customer crosswalk writes, operator reads and service status projection require their own schema, authority and retry tests before wiring. Provider provisioning, payments and billing are outside this handoff.
