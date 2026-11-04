# Independent review of public #60

Reviewed `fef62a1e7eb34698c305bd54bafcd89e286e865d`, stacked on #42.
Verdict: **HOLD for the bounded-response gap below.** Atomic quota reservation
is supported by the tests; production configuration and email delivery are not
verified. This review branch changes only tests and this document, not runtime
code, deployment wiring or settings.

## Finding R1 — high: the five-second limit does not bound the HTTP response

`api/shared/enquiryRateLimit.js` awaits download, body iteration and upload
directly. `AbortSignal.timeout(5000)` requests cancellation; `checkDeadline()`
only runs after the awaited operation settles. There is no independent timer
that settles the reservation promise. A dependency that does not honour the
signal keeps `/api/enquiry` pending and withholds the clear 503 response.

The new real-SDK reproduction uses the locked `@azure/identity` 4.13.1 and
`@azure/storage-blob` 12.31.0. It pauses only MSAL's token acquisition dependency
inside a real `ManagedIdentityCredential`; the real BlobClient authentication
pipeline receives the abort signal. After 5.25 seconds the signal is aborted,
but the HTTP handler still has no response. Only releasing token acquisition
with an error produces the sanitised 503. No Azure or email request is sent.
The installed credential's `getToken()` calls `acquireToken({ resource })`
without forwarding the caller's abort signal to that operation.

Additional deterministic reproductions pause an injected body stream and upload
across cancellation. These show the same await boundary, not an assertion that
the normal Azure HTTP transport ignores abort. A late upload still consumes a
permit and does not authorise an email: the failure is availability, not a
demonstrated quota bypass.

The original test named `timeout` rejects immediately; the late-write test
advances the clock only when the write finishes. Neither proves response latency.

Required closure: give the entire reservation an independent deadline covering
credential acquisition, download, body consumption, conflict retries and upload.
Cancel underlying work where supported; ensure late completion cannot return
permission or continue retrying, and retain uncertain committed permits. Handle
late rejection and destroy stalled streams so repeated timeouts do not leak work.
Then change the three **KNOWN GAP** reproductions to assert a bounded 503 before
releasing the blocked dependency, no email, and safe late completion. Green CI
for these current characterisation tests means the defects were reproduced,
**not** that this acceptance criterion passed. No runtime fix is included in this
review-only PR.

## Atomicity and race windows

- One primary blob and conditional `If-Match` writes form the shared boundary.
  Competing readers may see the same ETag, but only one write can commit; a
  definite 412/ConditionNotMet retries from a fresh read, up to eight attempts.
  There is no check-then-unconditional-write window or per-instance fallback.
- The existing independent-process fixture exercises real SDK requests against
  a persistent HTTP store, including worker/store restart and saturation.
  The new barrier test makes two handlers read the final free slot before either
  writes. The winner commits but loses its response (503); the loser re-reads the
  saturated counter (429). Both send zero emails and the counter holds 20 permits.
- Crashes, provider failures and ambiguous writes consume capacity without
  refunds. Date-header service time, monotonic-state checks and the six-second
  margin prevent worker clock skew or a within-deadline write shortening the
  rolling window. No atomicity defect was found under the single-primary-store
  contract. This is not a live Azure concurrency test.
- Once failures settle, missing/denied/corrupt storage returns a sanitised 503,
  exhaustion returns 429/Retry-After, and neither calls Resend. Browser tests prove
  returned errors preserve form values. During R1's stall, the browser remains
  waiting because its fetch also has no independent deadline.

## Exact production prerequisites — inspect/configure only in a separate task

Both `server.js`'s Express route and `api/enquiry/index.js`'s Function instantiate
the same service with the shared limiter by default. #42 supplies the endpoint
and public route. #60 supplies runtime gating, not resource provisioning or app
settings. No feature flag enables a fallback. Missing limiter configuration
produces 503 once delivery configuration is present. Inventory every serving
hostname and slot so no old sender can bypass the gate.

| App setting | Required value / behaviour |
| --- | --- |
| `NOFRIES_ENQUIRY_RATE_LIMIT_BLOB_URL` | Identical primary HTTPS URL on every sender: `https://<account>.blob.core.windows.net/enquiry-rate-limit/public-enquiry-v1.json`. No SAS, query, secondary endpoint or version/snapshot. The actual account must be selected/confirmed by the operator; none was inspected here. |
| `NOFRIES_MANAGED_IDENTITY_CLIENT_ID` | User-assigned managed identity client ID if that identity is used; otherwise omit for system-assigned identity. Do not confuse this with the identity's principal/object ID. |
| `RESEND_API_KEY` | Present, valid, allowed to send from the selected domain; inspect presence/permissions without displaying the value. |
| `NOFRIES_ENQUIRY_EMAIL_FROM` | Approved sender on a verified Resend domain. If absent, code falls back to `NOFRIES_SCOPE_EMAIL_FROM`; explicitly confirm which sender is used. |
| `NOFRIES_ENQUIRY_TO` | Omit for `hello@nofries.nz`, or set exactly that mailbox for this rollout. Code accepts other nonempty configured recipients; this operator constraint is not enforced by an allowlist. |

Resources: one Azure Storage account, dedicated **private** `enquiry-rate-limit`
container and pre-existing block blob `public-enquiry-v1.json`; runtime managed
identities with blob read/write data access scoped to that container. The built-in
role supporting the required write is **Storage Blob Data Contributor** (it also
grants delete; narrower custom data permissions may be used under separate
approval). Management-plane Contributor alone is insufficient. Verify private
DNS/network/firewall routing and HTTPS to the blob endpoint, runtime identity
endpoint availability, and outbound HTTPS to `api.resend.com`.

Provision empty state only once with all senders stopped:
`{"version":1,"lastObserved":0,"expires":[]}`. Never reset, restore, delete,
recreate or lifecycle-expire an active counter. Keep it during app rollback.
Failover or replacement requires all senders disabled and a wait of at least
one hour plus six seconds before a fresh budget starts. This review created no
resource, app setting, permission, credential or state blob.

## Azure / Resend acceptance checklist retained for Fry

1. Close R1 and obtain green final-head CI; record the exact #42/#60/review heads
   intended for release. Confirm both serving routes run that code.
2. Check all settings, shared blob, identity data access and network prerequisites
   above without revealing secrets. Do not assume infrastructure deploys them.
3. In isolated staging with a fake email sink, race two instances, exhaust 20
   permits, restart workers and verify attempt 21 sends nothing. Inject denied,
   missing, corrupt, slow and ambiguous storage and slow identity acquisition;
   require bounded 503/429 guidance, no send and no PII in logs.
4. Check the Resend domain is verified with its required SPF/DKIM records, sender
   matches that domain, key permits that sender, provider quota remains, and
   `hello@nofries.nz` accepts mail. Preserve existing inbound mail DNS records.
5. Under separate explicit live-test authorisation, send one synthetic enquiry
   and verify API acceptance, Resend delivery/bounce status **and actual inbox
   receipt**. Check Reply-To and form success/error behaviour. A limiter pass or
   HTTP 200 alone does not prove inbox delivery. No live send was run here.
6. Keep request-body/response-body capture and Azure SDK HTTP debug logging off.
   Record outcome codes and counts, not message contents, tokens or headers.

Reproduce locally:
`npm test -- --runInBand test/enquiryRateLimitReview.test.js test/enquiryRateLimit.test.js test/enquiryRateLimitProcesses.test.js test/enquiry.test.js`

Initial focused result: **55 tests passed in four suites**, including the four
new review tests. Hosted full application and PostgreSQL results belong on #686.

Primary contracts: [Azure concurrency](https://learn.microsoft.com/en-us/azure/storage/blobs/concurrency-manage),
[Put Blob authorisation](https://learn.microsoft.com/en-us/rest/api/storageservices/put-blob),
[Resend verified domains](https://resend.com/docs/dashboard/domains/introduction),
[Resend send API](https://resend.com/docs/api-reference/emails/send-email).
