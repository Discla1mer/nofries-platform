# Independent review and closure of public #60

Base: `fef62a1e7eb34698c305bd54bafcd89e286e865d`, stacked on #42.
The fixes from #65 are now carried into refreshed #60, closing the two
code/test gaps below without requiring a fourth merge. Production configuration and
actual inbox delivery remain unverified; the operator checklist still applies.
Final-head repeat-run and hosted CI evidence is recorded on #686.

## R1 — independent response deadline

Previously, cancellation alone left the HTTP handler waiting for managed-identity
acquisition, body EOF or upload completion. A real-SDK reproduction confirmed an
aborted signal with no response after 5.25 seconds.

The whole reservation now races an independent five-second deadline. Timeout
aborts transport, destroys the current stream and returns the sanitised 503
without email. Late downloads are destroyed, late upload/conflict/error outcomes
cannot send or retry, and ambiguous committed permits remain charged. Timers are
cleared on every returned result; late rejections are observed. Since an SDK
credential can ignore cancellation, each limiter retains at most 64 unsettled
operations; additional requests fail closed immediately until work settles.
This bounds local work, not the shared 20-per-hour email quota.

The tests now assert acceptance, using a controlled clock rather than sleeping:
503 before token/upload settlement or body EOF, no provider call, stream disposal,
no late retry, and recovery of the in-flight capacity after a late rejection.
They exercise the real locked identity/blob SDK authentication pipeline without
network credentials, plus explicit storage dependency barriers.

## R2 — deterministic process fixture and cleanup

Hosted run #97 timed out in the former cross-process test, then Jest reported
open asynchronous work until the job was cancelled. The old fixture awaited
child exit and store close without deadlines; those waits could outlive Jest's
30-second timeout. The log does not identify which wait originally stalled.

The replacement waits for worker READY messages, then releases all workers.
A server-side event barrier forces four reads of the same ETag and the test
requires at least three CAS conflicts. It preserves the 20-send cap and restart
assertions. Results travel over IPC; workers explicitly exit after the result
callback, and the parent waits for close rather than racing stdout against exit.
Every ready/result/store wait has a named deadline. The complete scenario is
bounded to 25 seconds inside the unchanged 30-second test limit. A finally block
kills unfinished workers, awaits their close, destroys sockets, closes the store
and removes its temporary directory. A fault test deliberately stalls a worker
and holds a store socket open, proving failure cleanup and directory removal.
There are no fixed sleeps, increased Jest/workflow timeouts or force-exit flags.

## Atomicity and race windows

- One primary blob and conditional `If-Match` writes form the shared boundary.
  Competing readers may see the same ETag, but only one write can commit; a
  definite 412/ConditionNotMet retries from a fresh read, up to eight attempts.
  There is no check-then-unconditional-write window or per-instance fallback.
- The existing independent-process fixture exercises real SDK requests against
  a persistent HTTP store, including worker/store restart and saturation.
  The additional barrier test makes two handlers read the final free slot before either
  writes. The winner commits but loses its response (503); the loser re-reads the
  saturated counter (429). Both send zero emails and the counter holds 20 permits.
- Crashes, provider failures and ambiguous writes consume capacity without
  refunds. Date-header service time, monotonic-state checks and the six-second
  margin prevent worker clock skew or a within-deadline write shortening the
  rolling window. No atomicity defect was found under the single-primary-store
  contract. This is not a live Azure concurrency test.
- Once failures settle, missing/denied/corrupt storage returns a sanitised 503,
  exhaustion returns 429/Retry-After, and neither calls Resend. Browser tests prove
  returned errors preserve form values. R1 now bounds server-side waiting for the shared limiter; unrelated client/network outages still depend on browser network handling.

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
| `NOFRIES_ENQUIRY_DELIVERY_VERIFIED` | Default unset/false; exactly `true` only after authorised inbox proof. Required by #43 for homepage promotion, together with valid provider and limiter configuration. |
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

1. Obtain green final-head CI for this closure; record the exact #42/#60/review heads
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

The targeted suite covers deadline acceptance, forced cross-process conflicts,
worker/store restart, quota conservation, failure cleanup and retained form data.
Historical #65 evidence at `25b8da3` (refreshed-head results are on #686):
on Node 22.22.0, 20 consecutive independent Jest invocations passed all 60
targeted tests (1,200 passes, zero failures/timeouts). Each invocation includes
the race/restart scenario and deliberate stalled-worker/open-socket cleanup.
Wall time per invocation: 2.146–4.231 seconds (median 2.405 seconds), with a
45-second external watchdog. The additional route/package suites passed 172
tests. Hosted full-suite results and the exact candidate head belong on #686.

Primary contracts: [Azure concurrency](https://learn.microsoft.com/en-us/azure/storage/blobs/concurrency-manage),
[Put Blob authorisation](https://learn.microsoft.com/en-us/rest/api/storageservices/put-blob),
[Resend verified domains](https://resend.com/docs/dashboard/domains/introduction),
[Resend send API](https://resend.com/docs/api-reference/emails/send-email).
