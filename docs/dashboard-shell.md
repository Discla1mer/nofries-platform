# Dashboard shell: source build and integration boundary

POR-009 implements the accepted PROD-002 dashboard navigation, Overview and Services design as reusable source. It is **not enabled on `/portal`**. The existing managed-service portal, provider-bound bootstrap and admission flags remain unchanged. No new public preview route, customer admission, upload, purchase, provider call or service activation exists.

## Try the actual renderer with synthetic data

From a complete repository checkout with Node 22.22 or later:

    node scripts/build-dashboard-preview.js

Open `test/fixtures/dashboard-preview.html` as a local file. The self-contained development preview includes eight scenarios: IT manager/Govern, executive/Score, a Cyber-only advisor, first use, stale figures, an entitled service awaiting setup, an unavailable Cyber module and another organisation. Its banner identifies all data as synthetic. Network connections and form submissions are blocked by its CSP. The real registry, server projection and renderer produce these views; this is not a separate mock UI implementation.

The preview output and fixture data live under `test/fixtures`, outside both production packaging plans. Do not add them to static assets or a public endpoint. The script is a local development utility, not an npm/release build step. Regenerating replaces only its named local preview output.

## Architecture

| Component | Responsibility | Does not do |
| --- | --- | --- |
| `api/shared/protectedAssets/dashboardRegistry.js` | Stable ordered module keys, labels, canonical fragments, mobile task groups and read-permission mapping | Grant access or define commercial entitlements |
| `api/shared/appLifecycle/dashboardProjection.js` | Compose current organisation, membership, POR-004 entitlement and POR-007 permission snapshots; allowlist browser-safe display data | Authenticate a request, load records, issue authority, enable providers or calculate scores |
| `api/shared/protectedAssets/dashboardShell.js` | Render the current display snapshot with safe text, route fallback, context replacement and accessible controls | Fetch, persist, mutate, score, activate or authorise |
| `app/dashboard.css` | Blue/navy/yellow brand, attention-first layout, responsive cards, mobile task navigation and focus/touch styles | Change the existing portal stylesheet |

`projectDashboard(input)` consumes trusted current `tenantAggregate`, `membershipState`, `entitlementState`, `scope`, `subjectKey`, `flags`, canonical `now`, optional current `advisorAssignments` by module and optional server-owned `summary`. It intersects explicit product scope with the existing permission resolver. A viewer does not gain assessment/evidence access; an advisor needs the exact matching assignment. Legacy requester/operator roles are not silently promoted to dashboard roles.

The output includes only organisation ID/name, presentation audience, subscription label, timestamp, permitted module states, non-operational service states and filtered summary fields. It deliberately excludes tenant IDs, immutable identity, agreements, grant IDs, provider identifiers, quotas and permission records. Both authority booleans remain false. This object is a display snapshot, never a bearer token or a resource-access decision.

The summary adapter must supply authorised, deterministic figures from the exact underlying records. The projection does not compute scores. Implementation attainment, evidence confidence, risk and trend stay distinct, with module, period, profile/version, assessment revision, evidence state and canonical timestamp. Missing data says “Not assessed”, not zero. Foreign organisation summaries are rejected; module summaries are filtered through permission and capability state. No universal record-count limit is imposed here; a future repository adapter must use a coherent complete snapshot or explicitly paginated contract.

`NoFriesDashboard.mount(root, projection, options)` renders one dashboard root and returns `navigate(route)` and idempotent `destroy()`. Replacing a projection destroys prior listeners, selected detail and DOM; an obsolete controller cannot clear its replacement. The server remains responsible for current access. For loading/error/denial, call `showState(root, state)`; it immediately removes previous organisation data. Optional `initialRoute` accepts a module fragment only. Unknown, unentitled and object-shaped routes fall back without echoing record identifiers.

## Experience and truthful states

Desktop uses the approved order: Overview, AI Governance and Strategy, Cyber Security, IT Optimisation, Improvement Plan, Evidence, Board Reports and Services. Mobile uses Home, Assess, Plan, Proof and More, omitting groups with no permitted module. Sibling links keep both assessment/proof routes reachable. Attention items show owner, due state, source and next action; their detail view returns focus to the originating item.

Only Overview and Services workspaces are implemented in this slice. Other entitled modules show an honest next-build notice, or an unavailable notice when disabled. Services distinguish available-to-scope, included-but-disabled and setup-required. All are non-operational. Expandable next-step guidance submits nothing and makes no price, service-hours, coverage or supplier claim.

Semantic headings, a skip link, visible focus, `aria-current`, textual status, labelled controls and roughly 46-pixel minimum controls are covered by deterministic DOM-contract tests. Responsive CSS covers desktop/mobile, narrow screens and reduced motion. **These are source/structural checks, not real-browser layout, screen-reader or physical-device verification.** Browser visual QA and the authenticated internal journey remain required before user-facing runtime acceptance.

## Authentication repair

The existing loader already requested `/portal` for sign-in, but `normaliseReturnTo` rejected it. This change adds only the exact `/portal` pathname; same-origin, encoding, control-character and path checks are retained. Fresh and expired sessions retain a bounded module-shaped fragment. Object-shaped or unsafe fragments are dropped; the dashboard route registry still applies permitted-module fallback after authentication. Neighbouring paths such as `/portal/`, `/portal-admin` and `/portal/other` remain rejected.

## Validation

    node --test test/dashboardShell.test.js test/portalEntry.test.js test/dashboardPackaging.test.js
    npm test -- --runInBand test/browserAuth.test.js test/portalLoader.test.js test/portalEntry.test.js test/dashboardShell.test.js test/dashboardPackaging.test.js
    npm run verify
    npm run eval:prospect:promptfoo

At the initial local verification checkpoint, all five targeted Jest suites passed **119 tests** using Jest 29.7 and Node 24.19. Full repository checks and exact frozen-head CI/preview are recorded in the PR. Independent review found and fixed stale-controller teardown and timestamp-validation defects. Neither a preview build nor CI is production proof.

## Deployment plan refinement

Keep two explicit milestones. The first is this reviewed **source shell**, independently useful for development and design inspection. The second is the **authenticated internal dashboard journey**: POR-005 must provide request authentication, current organisation selection, trusted snapshot loading, resource-by-resource permission checks, protected projection/bundle delivery, stylesheet packaging and fresh/expired-session integration. End-user Help/My Requests and operator queues remain their separate governed surfaces; this slice does not manufacture permissions for them.

The production baseline verified through release history is `6d9b11fcd2c4cebdca076ceb6f786e75542dc837`, run 33471025029 attempt 1. Before this change, protected main392bfc was seven commits/37 files ahead. Any release assessment must cover the cumulative baseline-to-candidate difference, not just this PR. Endpoint health was not re-probed by this review.

The exact `/portal` correction changes shared `browserAuth.js`, which the current classifier explicitly treats as connector-impacting. DEP-001's manifest/lock remediation is also connector-impacting. Preserve that classifier. Do not bundle dependency or release-controller changes into this UI item to bypass separate ownership or approval.

REL-001 PR183's published head remains superseded; its latest hosted CI was cancelled. An unpublished corrected snapshot is not final-head evidence. Its owner must resolve publication authority, publish the corrected frozen candidate, complete hosted CI and independent review, and satisfy exact connector identity, least-privilege, canary and recovery requirements before mutation. DEP-001 must then be refreshed and validated against current main in its own lane.

A frozen release still needs permitted full Moderate audit evidence, same-SHA protected live evaluation, cumulative drift/impact review, a valid recovery tuple and manual exact-SHA release followed by live verification. The recorded three Moderate root-runtime findings and incomplete full audit remain unresolved. The previously rejected registry audit must not be retried or routed around its permission decision. Build-only dependency exceptions cannot authorise release. No release, infrastructure, identity, billing or provider change was made here.

Customer admission, data/credentials and unrestricted uploads remain gated by SEC-002/RG-010 and exact admission authority. POR-006 owns provider activation guards; DATA-001 owns durable operational persistence and forced RLS. These are not waived by completing the source shell.
