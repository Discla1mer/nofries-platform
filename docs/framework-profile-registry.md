# Versioned framework-profile registry

ENG-001 introduces the source-only catalogue boundary for No Fries assessments.
It can represent more than one framework and profile without selecting an
evaluator, creating an assessment instance or changing any production route.

## Published profile contract

`api/shared/assessmentEngine/frameworkProfileRegistry.js` validates schema
version `1`. A publication contains:

- exact framework and profile IDs and opaque versions;
- publication and effective dates;
- attribution, basis, claim and limitation statements;
- HTTPS source records with version, verification and explicit rights status;
- domains, controls and questions joined by stable IDs;
- guidance at domain, control and question level;
- finite question weights and explicit response-option IDs; and
- a literal SHA-256 digest over the canonical publication content.

Validation is strict and bounded. Unknown fields, duplicate IDs or orders,
dangling references, unreferenced sources or response options, invalid dates,
non-HTTPS source URLs and active or prototype-bearing values are rejected. A
domain must have a control and every control must have at least one question.
Each question must offer at least one applicable option with a numeric factor,
and a control's finer-grained source references must be drawn from its declared
sources.

The constructors accept trusted, developer-curated in-process definitions, not
request, customer or plugin data. Validation also rejects accessors and Proxy
objects, but this boundary is not a general-purpose untrusted-code sandbox.
Descriptive catalogue text remains untrusted display content and must be
contextually output-encoded by every downstream renderer.

`rightsStatus: verified` or `synthetic` requires licence metadata. A source
marked `review_required` deliberately makes no reuse-rights claim until legal
review supplies one. Framework sources are consistent for an exact framework
version. Domain order is global within a profile; control order is scoped to a
domain and question order to a control.

Versions are opaque exact strings. `latest`, ranges, case folding and fallback
selection are not supported. Changing any published content changes the digest
and requires a governed new version.

## Immutable registry

Construct a closed registry from already published definitions:

```js
const {
    createFrameworkRegistry
} = require('../api/shared/assessmentEngine/frameworkProfileRegistry');

const registry = createFrameworkRegistry([publishedDefinition]);
const profile = registry.getProfile('profile-id', 'exact-version');
```

The registry copies and freezes retained definitions. `getProfile()`,
`getFramework()` and `listProfiles()` return defensive frozen clones. Framework
identity includes its metadata and framework-level source records; a repeated
framework ID/version must keep those exact values. Domains, controls and
questions are deliberately profile-scoped, so separate profiles of the same
framework version may select or weight them differently. There is no runtime
register, update, replace, delete or current-version operation. Unknown exact
tuples produce a typed lookup error.

`createFrameworkRegistry()` is injectable for focused tests. The production
singleton returned by `getDefaultFrameworkRegistry()` is closed and contains
only the pinned NCSC publication.

## NCSC adapter and provenance

`api/shared/assessmentEngine/ncscFrameworkProfile.js` maps the unchanged NCSC
source catalogue into the generic contract:

- five framework functions become domains;
- fourteen existing assessment items become controls;
- each current screening prompt becomes a question with weight `1`;
- current evidence examples and starting actions remain guidance;
- each Critical Control cross-reference retains its title, guidance URL,
  display order, verification date and review cadence; and
- the current response labels become generic response options.

The adapter fails closed unless the source tuple remains
`nz-ncsc-mcss-2025-v3-sme@2026-08-31.1` with source catalogue digest
`5bdde37694c51757bbd470e44bf7fda5936f8193282228897f93a9be2db418a3`.
The adapted publication has its own independent digest. The legacy getter,
profile body, evaluator and customer projector are not modified.

## Accepted NCSC-001 successor seed

`api/shared/assessmentEngine/ncscAcceptedFrameworkProfile.js` publishes the
Accepted NCSC-001 specification as the additive exact profile version
`2026-09-02.1` and framework version `beta-verified-2026-09-02`. It derives
from the historical generic publication so all five domain IDs, fourteen
control IDs, `${controlId}-Q1` question IDs, weights and response options remain
stable. The historical `2026-08-31.1` publication and both evaluators remain
unchanged.

The successor carries the Accepted attribution and CC BY 4.0 link, the excluded
asset and third-party-material boundaries, dedicated guidance URLs, the Critical
Controls review date, and the distinct technical SHA-256 of the retrieved MCSS
PDF. That upstream PDF hash is evidence, not an NCSC version or either No Fries
catalogue digest. The required schema field `effectiveFrom: 2025-10-30` is
explicitly described as the official MCSS publication-date pin, not an
NCSC-asserted effective date.

`importAcceptedNcscFrameworkProfile()` is a pure source seed import. An absent
exact tuple is inserted once, the identical publication is a no-op, and
different content under the accepted tuple fails closed. It returns a frozen
definition list for `createFrameworkRegistry()` and does not mutate its input.
Runtime evaluator selection remains outside NCSC-002.

Response options in schema version `1` are catalogue vocabulary, not a generic
scoring contract. A numeric implementation factor may represent a simple point;
`null` intentionally defers range, missing-value and aggregation semantics to a
compatible evaluator. In particular, the legacy NCSC unknown lower/upper range
and missing-as-unknown behaviour remain solely in the unchanged NCSC evaluator
for the historical profile. ENG-003 now implements the generic deterministic
evaluator; see `docs/assessment-engine/deterministic-evaluator.md`. NCSC-003
still owns the successor profile's explicit evaluator compatibility and fixtures.

The second profile in `test/fixtures/syntheticFrameworkProfile.json` is
invented test content. It proves structural independence with two domains,
three controls, four questions, non-uniform weights and one control mapped to
multiple questions. It is not registered for production use and is not a
customer or industry framework.

## Deliberate boundary

This registry establishes catalogue identity and integrity; a digest is not a
signature or proof of source authenticity. Generic assessment instances and
lifecycle belong to ENG-002. The implemented ENG-003 evaluator retains explicit
version and compatibility checks. The existing NCSC evaluator continues to
accept only its exact legacy NCSC profile; this seed does not change runtime
selection or admit a successor profile to that evaluator.
