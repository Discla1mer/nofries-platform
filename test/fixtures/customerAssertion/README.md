# Public-only customer assertion fixtures

These public verification inputs contain no private keys. The two upstream
fixtures below were imported without generating any credential or signature.
Nothing in this directory is registered with a live provider. Do not fetch the
upstream projects' private-key fixtures.

`openssl-rsa3072-leaf.pem` is OpenSSL's public `test/certs/ee-cert-3072.pem` at
commit `41eecc7c7cd4069b1b29bca49b9d97825c6bf648`:
https://github.com/openssl/openssl/blob/41eecc7c7cd4069b1b29bca49b9d97825c6bf648/test/certs/ee-cert-3072.pem
Original SHA256: `88ae70e2689a20dd5284dd40593c7070e1c7873296c7e5b4fd34630375f92820`.
This RSA3072 leaf exercises native DER parsing, public-key/expiry checks and
trailing-data rejection. Its public certificate signature is not a client JWT.

`wycheproof-rsa3072-pss.json` retains the public key and all 108 verification cases
from C2SP/Wycheproof `rsa_pss_3072_sha256_mgf1_32_test.json` at commit
`12fd3aaf33eb5fa1f52e026912ee00c054f9d984`:
https://github.com/C2SP/wycheproof/blob/12fd3aaf33eb5fa1f52e026912ee00c054f9d984/testvectors_v1/rsa_pss_3072_sha256_mgf1_32_test.json
Original SHA256: `cca48433e6d1accb57f65b3396c4f4dd93c776467101c3f0948e74c283fd4749`.
The selected fields are unchanged; redundant key encodings and explanatory
schema metadata are omitted. Both projects' licenses are retained here.

The keys in those two upstream sources differ. They establish native certificate
validation and native PS256 verification independently, not a successful full
certificate-to-JWT callback. Their existing tests and explicitly mocked positive
transport tests retain those narrower meanings.

## Matching disposable callback fixture

`native-callback-public.json` was generated on 9 October 2026 under the owner's
explicit authorization for a disposable, unregistered test key and self-signed
test certificate. SHA256 of the complete JSON file:
`49f59153ac05f87b22ba4481779f90a803c3eedf7d202432e242fd39c77a6135`.

The one-time generator used the already-installed Python cryptography50.0.0
library. It generated RSA3072 with exponent65537 in process memory, created a
genuine self-signed X509 leaf (`CA:FALSE`, digital-signature use), and signed two
exact synthetic JWT inputs with SHA256, MGF1-SHA256 and PSS salt length32. The
private key was never exported or written and its owning process exited. Only
public DER/JWK, exact inputs, digests, signatures and generation metadata remain.
The certificate is conspicuously marked `DISPOSABLE OFFLINE TEST - NEVER REGISTER`
and has a fixed two-day validity interval. It grants no service access.

`test/nativeCustomerCallbackProof.test.js` freezes time and UUID at each public
vector, then runs the real configuration selector, App Service credential, Key
Vault SDK, native verifier and MSAL against existing in-memory transports. The
token endpoint always rejects; there is no successful authentication. Native
cryptography is not mocked. Replay runs with outbound calls, local signing, key
generation and private-key import blocked. Changed signature, input or public key
fails before token submission.

This supplies matching native positive callback source evidence; independent
review of this follow-on remains required. It does not
prove real managed-identity hosting behavior, telemetry isolation, Key Vault
service compatibility, provider registration/acceptance or customer signup. It
does not authorize any fixture or test key for live registration. Do not regenerate
private material during the tests or retain a private key alongside this fixture.
