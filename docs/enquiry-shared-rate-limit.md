# Public enquiry delivery checks

The service reserves one of **20 attempts per rolling hour globally** before
calling Resend. The existing per-client memory limiter is supplementary. All
App Service/Functions instances must share the same primary Azure block blob.
ETag/If-Match serializes reservations; Azure's response Date supplies the clock.
Permits persist across worker restarts and are never refunded, including provider
failures or uncertain writes. A six-second retention margin covers the five-second
operation deadline and Date precision. The independent deadline returns 503 even
if credential acquisition ignores cancellation; late work cannot send or retry.
At most 64 unsettled reservations are retained per limiter instance; excess local
work fails closed until capacity is released. Streams and deadline timers are
cleaned up, while ambiguous stored permits are never refunded. Heavy contention fails closed after eight
conflicts. An attacker can exhaust this global cap; the manual email fallback
remains available. This cap bounds email attempts, not ingress/storage costs.

State contains only version, service time and up to 20 expiry timestamps. There
is no IP, name, email address, enquiry text or per-user key. No local fallback,
automatic state creation, expiry deletion or state reset is permitted. Missing,
denied, corrupt, timed-out or uncertain storage returns 503 without sending;
exhaustion returns 429/Retry-After without sending. Both leave the form populated.
Provider errors are reduced to fixed codes before logging.

## Authorised operator checklist (not verified or changed by this PR)

1. Inventory every route/hostname/slot that can serve `/api/enquiry`, including
   direct App Service and Functions access. Confirm they all use this service.
2. Confirm `NOFRIES_ENQUIRY_RATE_LIMIT_BLOB_URL` is identical everywhere and is
   `https://<account>.blob.core.windows.net/enquiry-rate-limit/public-enquiry-v1.json`.
   Use the primary endpoint, no SAS/query, CDN, secondary, snapshot or version URL.
   The dedicated private container must not contain signup/fence/customer records.
3. Confirm the blob already exists. For first provisioning only, while all senders
   are stopped, its UTF-8 JSON is `{"version":1,"lastObserved":0,"expires":[]}`.
   Never overwrite an existing counter, delete/recreate it, restore old state or
   apply a lifecycle deletion policy. Versioning/soft-delete aid investigation,
   not quota rollback. Reprovisioning/failover requires disabling senders and
   waiting at least one hour plus six seconds before starting a fresh budget.
4. Check each runtime's managed identity (`NOFRIES_MANAGED_IDENTITY_CLIENT_ID`
   if user-assigned, otherwise system-assigned), its existing blob read/write
   access, private DNS/network route and TLS reachability. If changes are needed,
   obtain the owner's separate authorisation; this PR changes no settings/roles.
5. Confirm `RESEND_API_KEY` is present in the runtime without displaying it;
   `NOFRIES_ENQUIRY_EMAIL_FROM` (or `NOFRIES_SCOPE_EMAIL_FROM` fallback) is an
   approved address on a verified Resend domain with required DNS records valid.
   `NOFRIES_ENQUIRY_TO` must be unset or exactly `hello@nofries.nz`. Confirm the
   Resend account/key can send to that mailbox, quota is sufficient and outbound
   HTTPS to `api.resend.com` works. Check delivery/bounce status and inbox receipt
   using one authorised synthetic enquiry; API acceptance alone is not delivery.
6. In an isolated staging account with a fake email sink, exercise concurrent
   requests on two instances, recycle both workers, and confirm attempt 21 is
   rejected. Test storage denial, missing/corrupt state, timeout and ambiguous
   write: 503, no provider call, no submitted data in app/SDK/access telemetry.
   Ensure request/response-body and Azure SDK HTTP debug logging are disabled.
7. Confirm the browser displays 429/503 guidance and retains entered values;
   test direct API routes too. Keep rate-limit state when rolling application
   code back. Disable the endpoint if rolling back to code without the shared
   gate, unless an independently verified upstream cap already protects it.

8. Follow [enquiry activation](enquiry-activation.md): initially leave
   `NOFRIES_ENQUIRY_DELIVERY_VERIFIED` unset/false. Confirm GET `/api/enquiry`
   reports `available: true, promote: false` without sending or consuming quota.
   After the authorised inbox delivery check in step 5 passes, set the flag to
   exactly `true` on every runtime and reload. With #43, the homepage then changes
   to Get early access; absent configuration or failed status reads retain signup.
   Clear the flag before delivery changes or on observed delivery failure.

## Evidence boundary

Tests use independent processes, real Azure SDK clients and a file-backed HTTP
fixture implementing the documented ETag/If-Match contract; restarting workers
and the fixture preserves saturation. This is not a live Azure/Resend check.
Azure concurrency contract: https://learn.microsoft.com/azure/storage/blobs/concurrency-manage
SDK service Date: https://azuresdkdocs.z19.web.core.windows.net/javascript/azure-storage-blob/12.31.0/interfaces/BlobDownloadResponseParsed.html
