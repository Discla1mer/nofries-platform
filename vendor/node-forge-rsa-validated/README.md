# Private Node-only Forge RSA validation backport

This package preserves the Node API of `node-forge@1.4.0` and applies the precise
`lib/rsa.js` change proposed in digitalbazaar/forge PR #1157. That proposal includes
PR #1152's nested DigestAlgorithm element-count check and rejects nonempty ASN.1
NULL parameters. Both upstream proposals were still open when inspected; this is
a private backport, **not an official upstream release**.

The consumer is promptfoo's optional `jks-js` PKCS#12 parser. Root development
dependencies install this exact archive as `node-forge` so the normal Jest suite
also exercises the installed backport. A scoped `jks-js` override prevents the
upstream vulnerable package from returning through that dependency. Production
application dependencies are unchanged.

`PROVENANCE.json` pins the original npm archive's published SHA-512 integrity,
both proposal commits, the patch and every packaged library file. The retained
`upstream-node-forge-1.4.0.tgz` is an unmodified build/test baseline, deliberately
containing the original defect. It is never installed. The generated archive
contains only all 49 Node library files, the original dual license and explicit
backport metadata. Every library file except `lib/rsa.js` is byte-identical to
the authenticated baseline. Original browser bundles and Flash assets are
excluded; this package makes no browser-distribution claim.

From the repository root, reproduce or verify the archive with Node, npm and
`patch` installed:

```sh
node vendor/node-forge-rsa-validated/build-package.js
node vendor/node-forge-rsa-validated/build-package.js --check
npm test -- --runInBand test/nodeForgeRsaValidated.test.js test/nodeForgePackage.test.js
```

Packing uses npm normally, with scripts disabled, and does not access the network.
The build validates archive paths/types, the original integrity, the exact patch,
all resulting library hashes and the package inventory before emitting bytes.
Verification reproduces every member name and byte; npm/zlib versions may encode
the gzip container differently. The lockfile separately pins the exact committed
archive's SHA-512 integrity, and tests compare installed files with that archive.
The normal test suite checks the committed artifact, installed alias and malformed
signature regressions; installation scripts are not a verification dependency.

The scoped private package identity makes registry advisory matching insufficient
to establish its security. A zero-result npm audit must be read together with the
pinned provenance, exact source patch, reproducible archive and regression tests.
No audit exception or weakened workflow gate is used. Replace this backport with
a compatible official release after its fixes and the same regression cases are
verified; do not replace it solely because a differently named fork audits clean.
