# App lifecycle and connector ownership

The production App Service and its retained Azure Function standby own the
mutable customer lifecycle. They load `api/shared/appLifecycleRuntime.js`,
which composes the modules under `api/shared/appLifecycle/`. Sales, prospect,
Datto RMM, service-desk, customer-portal, monthly-Proof and lifecycle routes
must all use that one App lifecycle singleton when they share production
storage. This keeps issued monthly-Proof snapshots, publication envelopes and
calendar reporting periods intact across every later App mutation.
The monthly-Proof scheduler resolves both its repository and service from that
runtime singleton in production; paired dependency overrides exist only for
isolated tests. The prospect evaluation harness also constructs the App stack,
so release evidence exercises the same writer schema deployed by App Service.

The public MCP connector is a separately released, read-only service. It alone
continues to use the default `api/shared/lifecycleRuntime.js` singleton and the
five shared lifecycle modules pinned to its last independently recoverable
release. REL-001 separately changes `api/shared/tenantAccess.js` through the
reviewed, versioned MCP application-subject contract: application access uses
the exact immutable `tid:oid:clientId` mapping, grants only the read-only
`mcp_reader` capability and rejects unmapped applications. It does not grant
browser dashboard membership or permit connector writes. Connector reads may normalise an in-memory view, but must
never write it back. The shared MCP protocol runtime retains that connector
default; App Service and retained Function wrappers must inject the App
lifecycle singleton for their hosted MCP routes. Connector wrappers must not
import the App lifecycle stack.

The routine unified release enforces this boundary in three ways:

- the five connector lifecycle files remain byte-identical to their pinned
  production blobs; the reviewed REL-001 `tenantAccess.js` version has a
  separate exact source pin and focused MCP/tenant-isolation tests;
- `validate-connector-impact.js` treats App lifecycle relocation paths as safe
  and requires authenticated same-target-SHA connector attestation for an
  impacting cumulative delta; and
- focused tests assert the exact import owners, connector non-loading of App
  modules, one App singleton, package inclusion, tenant isolation and an
  issue/read/mutate round trip that preserves both monthly-Proof digests and
  the reporting period.

Any future change that makes a connector wrapper or the shared MCP default use
an App lifecycle module, or makes an App writer use the connector-owned
lifecycle runtime, is a boundary change and requires an independently
rollbackable connector release. The governed path is
`.github/workflows/release-connector-production.yml`: it packages only the
checked-in connector dependency closure, binds exact candidate and rollback
identities and digests, and proves the released connector through authenticated
read-only and tenant-negative canaries. The thin unified App/static workflow may
accept a connector-impacting source delta only after the live connector has a
successful release from that workflow at the same exact target SHA; otherwise
it must fail closed. The subsequent unified release holds the connector
unchanged, and this release sequencing does not permit connector writes,
cross-stack lifecycle access or an App writer to use the connector-owned stack.
