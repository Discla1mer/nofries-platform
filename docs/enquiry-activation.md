# Enquiry activation and fallback

Merge order: #42 (form and availability), #60 (shared quota and bounded failures),
then #43 (conditional homepage promotion). Fry owns merging and releasing.
No infrastructure, settings, roles or secrets are changed by these PRs.

`GET /api/enquiry` is an anonymous, non-cacheable configuration read returning
only `{available, promote}` booleans. It does not send email, reserve capacity,
read the blob, acquire credentials or test provider health. Missing/failed/
malformed/slow responses fail closed in the browser after five seconds, including
stalled response bodies. The form remains disabled and offers hello@nofries.nz.
Native submission uses POST and JavaScript cancels navigation before any work;
no enquiry data enters a GET URL. POST still checks configuration at submission.

With `RESEND_API_KEY` and `NOFRIES_ENQUIRY_EMAIL_FROM` (or the existing
`NOFRIES_SCOPE_EMAIL_FROM` fallback) configured, the form can be used for an
explicitly authorised delivery check. `NOFRIES_ENQUIRY_TO` defaults to
`hello@nofries.nz`; verify any override goes to that mailbox. The shared limiter
in #60 adds its own configuration prerequisite and always gates actual sends.

The homepage in #43 retains main's signup link unless availability is true AND
`NOFRIES_ENQUIRY_DELIVERY_VERIFIED` is exactly `true`. This flag is an operator
attestation, default off, not an automated health claim. After release, Joel/Fry
must verify Resend sender/domain/DNS, runtime credentials and network access,
then send one authorised synthetic enquiry and confirm provider delivery AND
receipt in hello@nofries.nz (including reply-to). Only then enable the flag on
every serving runtime. Do not display secrets or record enquiry bodies in logs.
A green limiter or HTTP 200 alone is not proof of inbox delivery.

Clear the flag before changing credentials, sender, recipient or delivery
infrastructure, or after an observed delivery failure. Reload the homepage to
restore the signup CTA; existing pages are not a continuous health monitor.
Missing configuration also disables promotion even with a stale true flag.
On submission failures the form preserves entered text and offers manual email;
it must not claim that a failed or uncertain send succeeded. Keep signup and
returning-user login reachable. See the shared-rate-limit checklist in #60 for
Azure blob provisioning, identity, network, failure and rollback checks.
