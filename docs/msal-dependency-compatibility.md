# MSAL dependency remediation

Root and API directly pin `@azure/msal-node` 7.1.1 for
[GHSA-xcx6-jx8p-x3h5](https://github.com/advisories/GHSA-xcx6-jx8p-x3h5).
The root lock also resolves Promptfoo's existing MSAL 7 range to 7.1.1.
`@azure/identity` remains 4.13.1 (root/API) and 4.13.3 (Promptfoo).
A narrowly scoped Identity → MSAL 7.1.1 override removes the nested affected
version. This crosses Identity's declared MSAL major range and is a locally
validated compatibility choice, not an upstream-supported dependency pairing.
Promptfoo and vendor archives retain their versions. A refreshed audit also
reported [GHSA-6pq8-jhm2-2vcw](https://github.com/advisories/GHSA-6pq8-jhm2-2vcw)
against the existing root qs override. That override and its lock/inventory
entry move from 6.16.0 to the minimal fixed 6.16.1 release; API has no affected
qs declaration. Parser compatibility tests retain array-limit enforcement and
exercise hostile comma-stringify coercion plus ordinary serialization controls.
No exception is added or extended.

The [upstream sanitizer change](https://github.com/AzureAD/microsoft-authentication-library-for-js/commit/f550958)
restricts confidential authorization-response payloads to the request code,
trusted request nonce and response state. Routing and graph/cache metadata from
the supplied response payload no longer crosses that boundary. The application
already passes a bounded code and trusted PKCE/nonce rather than a raw payload;
all locked copies are nevertheless remediated.

The upstream [v6 migration guide](https://github.com/AzureAD/microsoft-authentication-library-for-js/blob/dev/lib/msal-node/docs/v6-migration.md)
and [v7 migration guide](https://github.com/AzureAD/microsoft-authentication-library-for-js/blob/dev/lib/msal-node/docs/v7-migration.md)
cover interactive loopback response-mode changes. The manually hosted
confidential flow used here retains `getAuthCodeUrl` with `form_post` and
`acquireTokenByCode`. Identity's installed `msal/nodeFlows/msalClient.js` uses
`acquireTokenByClientCredential` for secret/assertion credentials;
`credentials/managedIdentityCredential/index.js` uses `ManagedIdentityApplication`.

`test/msalRemediationCompatibility.test.js` executes the installed root/API and
optional Promptfoo SDKs with synthetic HTTP: hostile routing/cache metadata,
ordinary confidential code exchange, trusted nonce mismatch, PKCE, token cache,
client secret/assertion, DefaultAzureCredential's environment path, and App
Service managed identity. Existing customer signer identity boundary tests retain
their cancellation, concurrency, error-redaction and network confinement checks.
These checks make no live credential or token calls and do not establish live
tenant configuration, cloud-provider availability, or compatibility of unused
interactive/broker credentials.

The temporary acceptance still expires at `2026-10-27T00:00:00Z`, with its original
source fence and exact legacy restrictions. A missing MSAL audit finding passes
only when every locked MSAL declaration is a canonical stable version outside
the affected range. Unknown/malformed versions and any hidden vulnerable copy
fail closed. Other advisory and severity policy remains enforced. API override
permission is limited to the exact reviewed override, direct pin and locked
Identity/MSAL closure.

The ordinary Jest suite exercises the physical root SDK and checks every MSAL
lock declaration. It supports the existing public CI install contract
(`npm ci --ignore-scripts --omit=optional --audit=false`) without claiming that
API or optional SDKs were installed. Full-closure compatibility is separate,
required remediation evidence: after full exact-lock root and API installs, run
`node scripts/check-msal-full-closure.js`. That runner executes all the same SDK
assertions for the physical root, API and optional Promptfoo installs, and fails
if any labeled consumer falls back to an ancestor package or is missing. It
must pass before accepting this override; no live authentication is performed.
